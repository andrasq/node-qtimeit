/**
 * High-resolution function call timer.
 *
 * Copyright (C) 2014-2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 *
 * Notes:
 *   - the very first time a function is call takes the hit to compile it, is slow
 *   - the very first timed loop in a run shows lower performance than the others
 *     (perhaps due to linux /sys/devices/system/cpu/cpufreq/ondemand/up_threshold)
 *
 * 2014-07-01 - AR.
 * 2016-04-27 - fix calibration for loop count - AR.
 */

'use strict';


module.exports = timeit;
module.exports.reportit = reportit;
module.exports.fptime = fptime;
module.exports.runit = runit;
module.exports.bench = bench;
module.exports.sysinfo = sysinfo;
module.exports.cpuMhz = measureCpuMhz;

var version = require('./package.json').version;

var SILENT = '/* NOOUTPUT */';          // magic output string to silence the output
var scaling_governor="";

var setImmediate = global.setImmediate || function(fn, a, b, c) { process.nextTick(function() { fn(a, b, c) }) }
// NOTE: node-v0.10 does not like recursive nextTick

var noopSideEffect = 0;
function noop(x) {
    noopSideEffect = x;
}

function fptime() {
    // note: how trustworthy is hrtime?
    //return Date.now() * 0.001;
    var t = process.hrtime ? process.hrtime() : [Date.now() / 1000, 0];
    return t[0] + t[1] * 0.000000001;
}

function cputime() {
    var os = global.os || require('os');
    var cpus = os.cpus();
    var millis = 0;
    for (var i=0; i<cpus.length; i++) {
        millis += (cpus[i].times.user + cpus[i].times.sys) * 0.01;
    }
    return millis;
}

// repeatWhile must be a synchronous call to be serializable.
// If the call stack grows too deep, use callbacks.
function repeatWhile( test, visitor, callback ) {
    if (test()) {
        visitor(function(err){
            if (err) return callback(err);
            // self-recurse to work with both sync and async tests
            else repeatWhile(test, visitor, callback);
        });
    }
    else return callback();
}

// php str_repeat()
// 2x faster than str.repeat() for short runs of spaces, and same speed for long runs
// slightly faster for short non-space runs, 33% slower for long non-space runs
var _pads = ['', ' ', '  ', '   ', '    ', '     ', '      ', '       ', '        '];
function str_repeat( str, count ) {
    count = Math.floor(count);
    if (str === ' ' && count <= 8) return _pads[count];

    switch (count) {
    case 3: return str + str + str; break;
    case 2: return str + str; break;
    case 1: return str; break;
    case 0: return ''; break;
    default:
        var half = Math.floor(count / 2);
        var s2 = str_repeat(str, half);
        return (half + half < count) ? s2 + s2 + str : s2 + s2;
        break;
    }
}

function padRight( str, ch, width ) {
    var n = width - str.length;
    return (n >= 0) ? str + str_repeat(ch, n) : str;
}

function padLeft( str, ch, width ) {
    var n = width - str.length;
    return (n >= 0) ? str_repeat(ch, n) + str : str;
}

// 0.01357 => 0.014
function formatFloat( value, decimals ) {
    var power = 1, sign = '';
    // convert to fixed-point, make string, and insert decimal point
    // handle sign separately to round toward zero
    if (value < 0) { sign = '-'; value = -value; }
    for (var i = 0; i < decimals; i++) power *= 10;
    var digits = Math.floor(value * power + 0.5).toString();
    // left-pad a fraction with leading zeroes as needed
    while (digits.length <= decimals) digits = "0" + digits;
    return sign + digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}

// php number_format()
// 12345 => 12,345
function number_format( value ) {
    value = value + '';
    var i, j, s = "";
    for (j=0, i=value.length%3; j<value.length; j=i, i+=3) {
        s += s ? ',' + value.slice(j, i) : value.slice(j, i);
    }
    return s;
}

// return the value rounded to 3 digits of precision
function number_precision3( value ) {
    var pad = 0;
    while (value >= 1000) {
        value /= 10;
        pad += 1;
    }
    if (value >= 100) return ('' + (value + .5)).slice(0, 4) + str_repeat('0', pad);   // 123.4 => '123'
    if (value >= 10) return ('' + (value + .05)).slice(0, 4);   // 12.34 => '12.3'
    if (value >= 1) return ('' + (value + .005)).slice(0, 4);   // 1.234 => '1.23'
    return ('' + value + .0005).slice(1, 5);                    // .1234 => '.123'
}

// 100000 => 100k
function number_scale( value ) {
    if (value > 1e9) return number_precision3(value / 1e9) + 'g';
    if (value > 1e6) return number_precision3(value / 1e6) + 'm';
    if (value > 1e3) return number_precision3(value / 1e3) + 'k';
    return value;
}


// print run timing results
function reportit( f, nloops, __duration, totalSeconds, msg ) {
    var __rate = nloops/__duration;
    var m1 = (msg ? msg+" " : "")
    process.stdout.write((msg ? msg+" " : "") + '"' + f + '": ');
    process.stdout.write(nloops + " loops in " + formatFloat(__duration, 4) + " of " + formatFloat(totalSeconds, 2) + " sec: ");
    process.stdout.write(formatFloat(__rate, 2) + " / sec, " + formatFloat(__duration/nloops*1000, 6) + " ms each");
    process.stdout.write("\n");
}


var __calibrating = false;      // currently calibrating
var __timerOverhead;            // ms to make 1 fptime call
var __loopOverhead;             // ms to make 1000k test function calls
var __loopOverheadCb;           // ms to make 1000k test function calls with callback
var _calibrated = false;
function calibrate( ) {
    if (_calibrated) return;

    var i, t1, t2;
    var nloops = 4000000;

    // turn off calibration for our internal timeit() runs
    __calibrating = true;

    // Note: for calibration, x = [1,2,3] runs at 91-92m/s and x = new Array() at 74-75m/s
    // (nb: but "x = [1,2,3]; x" runs at only 87m/s ? Optimizer effects?)
    // Remember to subtract out loop overhead (.15 sec per 100m) and node startup (.05 sec).
    // Note: node optimizes and de-optimizes functions on the fly.  Need to also
    // time the de-optimized version, and get a sense of the split between them.
    // For more consistent (and accurate) timings, run the test by count for 0.05 seconds.
    // This seems to run +- 5% and avoids the weird outliers that range +- 25% from 92m/s.
    // (tests that do more work per call are less sensitive to overhead errors, of course)
    var x, count = 0;
    function testNoop() {}
    function testFunc(){ }
    //function testFunc() { count += 1; x = count + count; }

    // warm up cache
    for (i=0; i<5000; i++) fptime();
    timeit(5000, testFunc, '/* NOOUTPUT */');

    // time fptime overhead, seconds for one call
    var info = timeit(1000, function(){ t2 = fptime(); t2 = fptime(); t2 = fptime(); t2 = fptime(); t2 = fptime(); }, '/* NOOUTPUT */');
    __timerOverhead = info.wallclock / 1000 / 5;

    // time test overhead without callback, per million calls
    // adjust __loopOverhead to make info.elapsed converge to zero
    var timings = [];
    nloops = 1e5;
    for (var i=0; i<8; i++) {
        var info = timeit(nloops, testFunc, '/* NOOUTPUT */');
        if (info.elapsed > -Infinity) timings.push([Math.abs(info.elapsed), __loopOverhead]);
        __loopOverhead = (info.wallclock) / (nloops / 1e6) - (info.elapsed > -Infinity ? info.elapsed / (nloops / 1e6) / (i+2) : 0);
    }
    //var minIdx = 0;
    //for (var i=0; i<timings.length; i++) if (timings[i][0] <= timings[minIdx][0]) minIdx = i;
    //__loopOverhead = timings[minIdx][1];

    __calibrating = false;

    // disable optimization of this function
    try { testNoop() } catch (e) { }
    noop(arguments);

    _calibrated = true;

/*  // disable inlining of this function
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
*/
}

var _calibratedCb;
function calibrateCb( nloops, cb ) {

    if (_calibratedCb) return cb();

    __calibrating = true;

    var x;
    function testFunc(cb) {
        // adding a side-effect to the test function results in more accurate timings;
        // it does not cancel out the side-effect of the tested function.
        // TODO: this seems wrong, see how to get rid of this side-effect here.
        x = cb();
    }

    // warm up cache
    for (var i=0; i<5000; i++) fptime();

// FIXME: if warming up cache w/ testFunc, understimates by 20%
// compared to warming up testFunc invoked from a wrapper
    //timeit(5000, testFunc, '/* NOOUTPUT */', function(err, count, elapsed, wallclock) {
    timeit(50000, function wrapper(cb) { testFunc(cb) }, '/* NOOUTPUT */', function(err, count, elapsed, wallclock) {
        nloops = 1e5;
        // note: let the test func run 0.1 sec or more, else overstimates 92m/s rate by 25%
        var nloops = Math.round(0.10 / (wallclock - __timerOverhead) * 5000);
        if (nloops <= 0) nloops = 1;

        var repeatCount = 0;
        repeatWhile(
            function(){
                return repeatCount++ < 8;
            },
            function(done) {
                // time test overhead with callback, per million calls
                timeit(nloops, testFunc, '/* NOOUTPUT */', function(err, count, elapsed, wallclock){
                    // adjust __loopOverheadCb to make elapsed converge to zero
                    var adjust = elapsed > -Infinity ? elapsed / (nloops / 1e6) / (repeatCount-1+2) : 0;
                    __loopOverheadCb = (wallclock - __timerOverhead) / (nloops / 1e6) - adjust;
                    done();
                    try { } catch(e) { }
                });
                try { } catch (e) { }
            },
            function() {
                __calibrating = false;
                _calibratedCb = true;
                setImmediate(cb);
            }
        )
    });

/*  // disable inlining of this function
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
*/
}

// return a loop count that will run the testFunc for target seconds
// If target is an integer, it is already a loop count and will be returned as-is.
function calibrateLoopCount( target, testFunc, cb ) {
    var t1, t2, nloops = 1;
    if (!cb) {
        if (target % 1 === 0) return target;
        __calibrating = true;
        do {
            var info = timeit(nloops, testFunc, SILENT);
            nloops = Math.round(nloops * 0.02 / info.wallclock);
        } while (info.wallclock < 0.02);
        nloops = Math.round(nloops * target / 0.02);
        if (nloops <= 0) nloops = 1;
        __calibrating = false;
        return nloops;
    }
    else {
        if (target % 1 === 0) return cb(null, target);
        var stop = false;
        __calibrating = true;
        repeatWhile(
            function(){
                return !stop;
            },
            function(done) {
                timeit(nloops, testFunc, SILENT, function(err, count, elapsed, wallclock) {
                    if (err) return done(err);
                    nloops = Math.round(nloops * 0.02 / wallclock);
                    if (wallclock >= 0.02) {
                        nloops = Math.round(nloops * target / wallclock);
                        stop = true;
                    }
                    done();
                })
            },
            function(err) {
                __calibrating = false;
                if (nloops <= 0) nloops = 1;
                return setImmediate(cb, err, nloops);
            }
        )
    }
}

// parse the body into a function (to use as the test function)
function makeFunction( body ) {
    return Function(body);      // jshint ignore:line
}

/*
 * run the function f nloops times, and report on its performance
 */
function timeit( nloops, f, msg, callback ) {
    var __i, __fn = (typeof f === 'function' ? f : makeFunction(f));
    var __t1, __t2, __callCount = 0;
    var __nleft;
    var __stopTime, __timedRun = false;
    if (typeof msg === 'function') { callback = msg; msg = undefined; }

    if (nloops !== null && nloops <= 0) {
        if (callback) callback(null, 0, 0, 0);
        return { count: 0, elapsed: 0, wallclock: 0 };
    }

    // disable optimization of this function.  Its overhead is subtracted out,
    // and optimization would make the overhead less predictable.
    try { } catch (e) { }

    if (__timerOverhead === undefined && !__calibrating) {
        // calibrate, then use the measured overhead to re-calibrate more accurately
        calibrate();
        calibrate();
    }

    function maybeCalibrateCb(cb) {
        // calibrate unless already calibrating
        if (!__calibrating) calibrateCb(nloops, cb);
        else cb();
    }

    var elseBlock;
    if (!callback) {
        // node v0.11.x strongly penalizes parsing the function in the timed loop; v0.10 did not.
        // Run the test function once to pre-parse it
        __fn();

        nloops = calibrateLoopCount(nloops, __fn);

        __t1 = fptime();
        __stopTime += __t1;
        for (__i=0; __i<nloops; __i+=5) {
            __callCount += 5;
            __fn(); __fn(); __fn(); __fn(); __fn();
            if ((__callCount & 0xFFF) === 0 && __timedRun && fptime() >= __stopTime) break;
        }
        __t2 = fptime();

        var __duration = (__t2 - __t1 - __timerOverhead - (__loopOverhead * __callCount * 0.000001));
        if (__timedRun) {
            var timedRunOverhead = (Math.floor(__callCount / 4096)) * __timerOverhead;
            __duration -= timedRunOverhead;
        }
        if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, (__t2 - __t1), msg ? msg : "");

        return {count: __callCount, elapsed: __duration, wallclock: __t2 - __t1 };
    }
    else (elseBlock = function(){
        var __t1, __depth;
        maybeCalibrateCb(function() {
            calibrateLoopCount(nloops, __fn, function(err, ret) {
                nloops = ret;
                __fn( function() {
                    // timed test begins here, called after __fn has been precompiled
                    __nleft = nloops;
                    __depth = 0;
                    __t1 = fptime();
                    __launchNext();
                    try { } catch(e) { }
                });
                try { } catch(e) { }
            });
        });

        function __launchNext() {
            if (__nleft) {
                __nleft -= 1;
                __depth += 1;
                __callCount += 1;
                // disable optimization in the test invoker, to make overhead more stable
                // results are unrealistically low (by 50%) if not in try-catch
                __fn(__onTestDone);
            }
            else {
                __t2 = fptime();
                var __duration = (__t2 - __t1 - (__timerOverhead > 0 ? __timerOverhead : 0) - (__loopOverheadCb * __callCount * 0.000001));
                if (__timedRun) {
                    var timedRunOverhead = (Math.floor(__callCount / 4096)) * __timerOverhead;
                    __duration -= timedRunOverhead;
                }
                if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, (__t2 - __t1), msg ? msg : "");
                callback(null, __callCount, __duration, __t2 - __t1);
            }
            try { } catch(e) { }
        }
        function __onTestDone() {
            if (__depth > 20) { __depth = 0; setImmediate(__launchNext); }
            else __launchNext();
            try { } catch(e) { }
        }
    })();
}

function runit( repeats, nloops, nItemsPerRun, name, f, callback ) {
    var j = 0;
    var t1, t2, rateMin, rateMax;
    var totalCallCount = 0, totalRunTime = 0, totalWallclockTime = 0;

    repeatWhile(
        function() {
            return j++ < repeats;
        },
        function(next) {
            t1 = timeit.fptime();
            timeit(nloops, f, function(err, ncalls, elapsed) {
                t2 = timeit.fptime();
                totalWallclockTime += t2 - t1;
                totalCallCount += ncalls;
                totalRunTime += elapsed;
                var rate = ncalls / elapsed;
                if (rateMin === undefined || rate < rateMin) rateMin = rate;
                if (rateMax === undefined || rate > rateMax) rateMax = rate;
                next(err);
            });
        },
        function(err) {
            var rateAvg = totalCallCount * nItemsPerRun / totalRunTime;
            console.log("Total runtime %s of %s elapsed", formatFloat(totalRunTime, 3), formatFloat(totalWallclockTime, 3));
            console.log("item rate min-max-avg %s %s %s", formatFloat(rateMin, 2), formatFloat(rateMax, 2), formatFloat(rateAvg, 2));
            if (err) throw err;
            if (callback) callback();
        }
    );
}

var fs = require('fs');
var os = require('os');
var child_process = require('child_process');
var util = require('util');

var scaling_governor = "";
var scaling_governor_file = "/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor";
child_process.exec("cat " + scaling_governor_file, function(err, stdout, stderr) {
    // race condition: node-v0.10.42 does not have execSync,
    // so cat the scaling_governor files now, and hope they arrive in time
    if (!err) {
        scaling_governor = stdout.toString().replace(/\n/g, ' ').trim();
    }
})

function measureCpuMhz( ) {
    var node = process.argv[0];
    var argv = [
        "stat", "-e", "cycles,task-clock",
        node, "-p", 'tm = Date.now() + 100; do { for (i=0; i<1000000; i++) ; } while (Date.now() < tm);',
    ];
    try {
        var results = child_process.spawnSync("/usr/bin/perf", argv);
        if (!results || String(results.stderr).indexOf(' cycles ') < 0) {
            throw new Error("/usr/bin/perf error");
        }
        if (results.error || results.status !== 0) {
            // could not measure with /usr/bin/perf, hope the os can measure for us
            return measureOsSpeed();
        }
        var lines = results.stderr.toString().replace(',', '').split('\n');
        var cycles, ms;
        for (var i=0; i<lines.length; i++) {
            if (lines[i].indexOf(' cycles ') > 0) cycles = parseFloat(lines[i].replace(/,/g, ''));
            if (lines[i].indexOf(' task-clock ') > 0) ms = parseFloat(lines[i]);
        }
        return Math.round(cycles / ms / 1000 + .5);
    }
    catch (err) {
        console.log("unable to measure cpu mhz:", err.message);
        return measureOsSpeed();
    }

    function measureOsSpeed() {
        // burn 100ms of cpu to raise core speed to its max, then see what linux reports
        var tm = Date.now() + 100;
        do { var x; for (var i=0; i<100000; i++) x += i; } while (Date.now() < tm);
        return maxSpeed(os.cpus()) + "[os]";
    }

    function maxSpeed(cpus) {
        var mhz = 0;
        for (var i=0; i<cpus.length; i++) if (cpus[i].speed > mhz) mhz = cpus[i].speed;
        return mhz;
    }
}

function sysinfo( ) {
    var cpuMhz = measureCpuMhz();
    var up_threshold_file = "/sys/devices/system/cpu/cpufreq/ondemand/up_threshold";
    var scaling_governor_file = "/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor";
    // up_threshold does not exists if ~/cpu/cpu*/cpufreq/scaling_governor is all "performance"
    var up_threshold = fs.existsSync(up_threshold_file) && fs.readFileSync(up_threshold_file).toString().trim();
    if (process.version >= 'v4.') {
        scaling_governor = fs.existsSync(scaling_governor_file.replace('*', '0')) && child_process.execSync("cat " + scaling_governor_file).toString().replace(/\n/g, ' ').trim();
    }
    var sysinfo = {
        qtimeitVersion: version,                // 0.15.0
        nodeTitle: process.title,               // 'node'
        nodeVersion: process.versions.node,     // '5.10.1'
        v8Version: process.versions.v8,         // '4.6.85.31'
        platform: process.platform,             // 'linux'
        arch: process.arch,                     // 'ia32'
        kernel: os.release(),                   // `uname -r`
        cpu: os.cpus()[0].model,                // `grep '^model name' /proc/cpuinfo`
        cpuMhz: cpuMhz,                         // `grep 'MHz' /proc/cpuinfo` or use `perf` to compute
        cpuCount: os.cpus().length,             // `grep -c '^model name' /proc/cpuinfo`
        cpuUpThreshold: up_threshold,           // `cat $up_threshold_file`
        cpuScalingGovernor: scaling_governor,   // `cat $scaling_governor_files`
    };

    return sysinfo;
}

function bench( /* options?, */ functions, callback ) {
    function computeDigest( results ) {
        var min = Infinity, max = -Infinity, rate = 0, count = 0, elapsed = 0;
        var icount, ielapsed, nsamples = 0;
        for (var i=0; i<results.length; i++) {
            icount = results[i].count;
            count += icount;
            ielapsed = results[i].elapsed;
            if (ielapsed > 0) {
                elapsed += ielapsed;
                rate = icount / ielapsed;
                nsamples += 1;
                if (rate < min) min = rate;
                if (rate > max) max = rate;
            }
            else {
                // console.log("negative runtime not summed");
            }
        }
        var avg = count / elapsed;
        return {
          min: min,
          max: max,
          avg: avg,
          count: count,
          elapsed: elapsed,
          runs: results.length,
          stats: results,
        }
    }


    function runTest( timeGoal, test, cb ) {
        var startTime = timeit.fptime();
        var endTime;
        var results = [];

        if (!cb) {
            var tm = timeit.fptime(); test(); tm = timeit.fptime() - tm;
            var nloops = calibrateLoopCount(timeGoal, test);
            endTime = timeit.fptime() + timeGoal;
            do {
                var result = timeit(nloops, test, "/* NOOUTPUT */");
                results.push(result);
            } while (timeit.fptime() < endTime);
            var duration = timeit.fptime() - startTime;
            var digest = computeDigest(results);
            digest.duration = duration;
            digest.nloops = nloops;
            return digest;
        }
        else {
            calibrateLoopCount(timeGoal, test, function(err, nloops) {
                if (err) return cb(err);
                endTime = timeit.fptime() + timeGoal;
                repeatWhile(
                    function() {
                        return (fptime() < endTime);
                    },
                    function(next) {
                        timeit(nloops, test, "/* NOOUTPUT */", function(err, callCount, cpuTime) {
                            if (err) return next(err);
                            results.push({ count: callCount, elapsed: cpuTime });
                            next();
                        })
                    },
                    function(err) {
                        var duration = timeit.fptime() - startTime;
                        var digest = computeDigest(results);
                        digest.duration = duration;
                        digest.nloops = nloops;
                        setImmediate(cb, null, digest);
                    }
                )
            });
        }
    }

    var timeGoal = bench.timeGoal || 4.00;
    var baselineAvg = bench.baselineAvg || undefined;
    var opsPerTest = bench.opsPerTest || 1;
    var visualize = bench.visualize || true;
    var forkTests = bench.forkTests || false;
    var isForked = Boolean(process.env._QTIMEIT_TEST);
    // TODO: pick verbosity levels, verbosity ctl syntax
    var verbose = bench.verbose || 2;
    var showSource = bench.showSource !== undefined ? bench.showSource : verbose >= 4;
    var showPlatformInfo = bench.showPlatformInfo !== undefined ? bench.showPlatformInfo : verbose >= 1;
    var showTestInfo = bench.showTestInfo !== undefined ? bench.showTestInfo : verbose >= 3;
    var showRunDetails = bench.showRunDetails !== undefined ? bench.showRunDetails : false;
    var bargraphScale = bench.bargraphScale || 5;
    var sys = sysinfo();
    var results = [];
    var tests = {};

    if (Array.isArray(functions)) for (var i=0; i<functions.length; i++) tests['#'+(i+1)] = functions[i];
    else tests = functions;

    if (bench.cpuMhz > 0) sys.cpuMhz = bench.cpuMhz + "[u]";

    if (!isForked && showSource) {
        // show the source code for each test
        for (var k in tests) {
            console.log("%s: %s", k, tests[k]);
        }
        console.log("");
    }

    // prepend a canned message to the tests, to allow forked tests to output
    if (bench.preRunMessage && !isForked) console.log(bench.preRunMessage);

    // if invoked recursively to run a single test, omit the header
    if (!isForked) {
        if (showPlatformInfo) {
            // basic test details, shown unless silent
            console.log("qtimeit=%s node=%s v8=%s platform=%s kernel=%s up_threshold=%s",
                sys.qtimeitVersion, sys.nodeVersion, sys.v8Version, sys.platform, sys.kernel, sys.cpuUpThreshold);
            console.log('arch=%s mhz=%s cpuCount=%s cpu="%s"',
                sys.arch, sys.cpuMhz, sys.cpuCount, sys.cpu);
        }
        if (showTestInfo) {
            // additional details
            console.log('timeGoal=%s opsPerTest=%s forkTests=%s',
                timeGoal, opsPerTest, forkTests);
        }
    }

    var testNames = Object.keys(tests);
    var maxNameWidth = 0;
    for (var i=0; i<testNames.length; i++) if (testNames[i].length > maxNameWidth) maxNameWidth = testNames[i].length;
    var nameColumnWidth = maxNameWidth;
    var opsColumnWidth = 13;
    var metaColumnWidth = 60;
    var rankColumnWidth = 6;
    var bargraphStr = '>';
    var bargraphStrLimit = 500;
    var spacer = '';
    if (!visualize) {
        nameColumnWidth = opsColumnWidth = metaColumnWidth = rankColumnWidth = 1;
        bargraphStr = '';
        spacer = ' ';
    }

    // if invoked recursively to run a single test, use the precomputed format settings
    if (isForked) {
        var testSettings = JSON.parse(process.env._QTIMEIT_TEST);
        if (testSettings.testNames) testNames = testSettings.testNames;
        if (testSettings.nameColumnWidth) nameColumnWidth = testSettings.nameColumnWidth;
    }

    repeatWhile(
        function() {
            return testNames.length > 0;
        },
        function(next) {
            var testName = testNames.shift();
            var test = tests[testName];
            //process.stdout.write(testName + " ");

            // if forking each test, invoke self recursively instead of running now
            if (forkTests && !isForked) {
                process.env._QTIMEIT_TEST = JSON.stringify({ testNames: [testName] });
                var child = child_process.fork(process.argv[1]);

                var err, res;
                child.on('message', function(msg) {
                    err = msg.err;
                    res = msg.res;
                })
                child.on('exit', function(code, signal) {
                    if (!err && !res) err = new Error(testName + ": no response from forked test, code " + (signal || code));
                    else afterTest(err, res, testName);
                })
            }

            // run test when standalone or is forked child test runner
            if (!forkTests || isForked) {
                callback ? runTest(timeGoal, test, afterTest) : afterTest(null, runTest(timeGoal, test));
            }

            function afterTest(err, res) {
                if (opsPerTest != 1) res.avg = res.count * opsPerTest / res.elapsed;
                results.push({ name: testName, results: res });
                var baseline = { avg: baselineAvg ? baselineAvg : results[0].results.avg };
                if (results.length === 1) {
                    // use narrower columns if possible to save output width
                    if (res.avg < 1000) opsColumnWidth = 7;
                    else if (res.avg < 100000) opsColumnWidth = 9;
                    metaColumnWidth = composeMetaInfo(testName, test, res, baseline).length + 2;
if (metaColumnWidth < 60) metaColumnWidth = 60;

                    // write the column titles
                    if (!isForked) {
                        var metaTitle = (verbose < 2) ? "" : padRight("(stats)", ' ', metaColumnWidth);
                        if (!showRunDetails) metaTitle = '';
                        console.log("%s%s %s         %s%s",
                            padRight("name", ' ', nameColumnWidth), spacer, padLeft("speed", ' ', opsColumnWidth),
                            metaTitle, padLeft("rate", ' ', rankColumnWidth));
                    }
                }
                if (isForked) process.send({ err: err, res: res });
                else reportResult(testName, test, res, baseline);
                callback ? setImmediate(next) : next();
            }
        },
        function(err) {
            if (callback) callback(err, results);
        }
    );

    function reportResult( name, test, res, res0 ) {
        var rank = Math.round(1000 * res.avg / res0.avg);
        var meta = composeMetaInfo(name, test, res, res0);
        var metaColumn = verbose < 2 ? '' : padRight(meta, ' ', metaColumnWidth);
        if (!showRunDetails) metaColumn = '';
        var maxGraphRank = bargraphStrLimit / bargraphScale * 1000;
        var graphRank = !isFinite(rank) ? 0 : rank > maxGraphRank ? maxGraphRank + 1 : rank;
        console.log("%s%s %s ops/sec %s%s%s %s",
            padRight(name, ' ', nameColumnWidth), spacer, padLeft(number_format(res.avg >>> 0), ' ', opsColumnWidth),
            metaColumn,
            '',
            padLeft('' + rank, ' ', rankColumnWidth),
            padRight('', '>', Math.round(bargraphScale * graphRank / 1000)) + (graphRank > maxGraphRank ? '+' : ''));
    }

    function composeMetaInfo( name, test, res, res0 ) {
        var meta = util.format("(%d runs of %s calls in %s out of %s sec, +/- %s%%)",
            res.runs, number_scale(res.nloops), formatFloat(res.elapsed, 3), formatFloat(res.duration, 3),
            formatFloat((res.max - res.min)/2/res.avg * 100, 2)
        );
        return meta;
    }
}
