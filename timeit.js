/**
 * High-resolution function call timer.
 *
 * Copyright (C) 2014-2017 Andras Radics
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

var scaling_governor="";

if (!global.setImmediate) global.setImmediate = function(a, b, c) { process.nextTick(a, b, c) };

var noopSideEffect = 0;
function noop(x) {
    noopSideEffect = x;
}

function fptime() {
    // note: how trustworthy is hrtime?
    //return Date.now() * 0.001;
    var t = process.hrtime();
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

// 100000 => 100k
function number_scale( value ) {
    if (value > 1000000) return (value / 1000000) + 'm';
    if (value > 1000) return (value / 1000) + 'k';
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


var __timerOverhead;            // ms to make 1 fptime call
var __loopOverhead;             // ms to make 1000k test function calls
var __loopOverheadCb;           // ms to make 1000k test function calls with callback
function timeFunc( n, fn ) {
    var t1 = fptime();
    for (var i=0; i<n; i++) fn();
    var t2 = fptime();
    return t2 - t1;
    try { noop(arguments) } catch (e) { }
}
function calibrate( ) {
    var i, t1, t2;

    // turn off calibration for our internal timeit() runs
    __timerOverhead = -1;

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
    for (i=0; i<2000; i++) fptime();
    for (var i=0; i<100; i++) timeit(100, testFunc, '/* NOOUTPUT */');

    // calibrate the function calls and the work done in the test function
    var callTime = timeFunc(4000000, testNoop) / 4;
    var testWorkTime = timeFunc(4000000, testFunc) / 4 - callTime;

    // time fptime overhead, seconds for one call
    __timerOverhead = timeFunc(500, function(){ t2 = fptime() }) / 500;

    // time test overhead without callback, per million calls
    var timeitTime = timeFunc(1, function(){ timeit(4000000, testFunc, '/* NOOUTPUT */') }) / 4;
    //__loopOverhead = timeitTime - testWorkTime;
    __loopOverhead = timeitTime;

    // disable optimization of this function
    try { testNoop() } catch (e) { }
    noop(arguments);

/*  // disable inlining of this function
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
*/
}

function calibrateCb( nloops, cb ) {
    if (nloops < 1000000) nloops = 2000000;
    else if (nloops > 10000000) nloops = 10000000;

    var savedTimerOverhead = __timerOverhead;
    __timerOverhead = -1;
    for (var i=0; i<1000; i++) timeit(10, function(cb){ cb() }, '/* NOOUTPUT */', function(){});

    // time test overhead with callback, per million calls
    var t1 = fptime();
    timeit(nloops, function(cb){ cb() }, '/* NOOUTPUT */', function(){
        // note: let the test func run 0.1 sec or more, else overstimates 92m/s rate by 25%
        // Note: passing a separately defined testFunc to timeit here _under_estimates the rate by 75%.
        var t2 = fptime();
        __loopOverheadCb = (t2 - t1) / (nloops / 1000000);
        __timerOverhead = savedTimerOverhead;
        cb();
    });

    // disable optimization of this function
    try { } catch (e) { }
    noop(arguments);

/*  // disable inlining of this function
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
*/
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

    // if the loop count is a decimal, repeat for that many seconds
    if (nloops % 1 !== 0) {
        __timedRun = true;
        __stopTime = nloops; // + t1 later
        setTimeout(function(){
            nloops = __callCount;
            __nleft = 0;
        }, Math.round(nloops * 1000));
        nloops = Infinity;
        // TODO: a timed-duration callback test reports only half the throughput, 92m/s -> 43m/s
    }

    // disable optimization of this function.  Its overhead is subtracted out,
    // and optimization would make the overhead less predictable.
    try { } catch (e) { }

    // TODO: try calibrating every run, instead of just once at the very start.
    if (__timerOverhead === undefined) {
        // calibrate, then use the measured overhead to re-calibrate more accurately
        calibrate();
        calibrate();
    }

    function maybeCalibrateCb(cb) {
        // calibrate unless already calibrating
        if (__timerOverhead >= 0) calibrateCb(nloops < Infinity ? nloops : 4000000, cb);
        else cb();
    }

    if (!callback) {
        // node v0.11.x strongly penalizes parsing the function in the timed loop; v0.10 did not.
        // Run the test function once to pre-parse it
        __fn();

        __t1 = fptime();
        __stopTime += __t1;
        for (__i=0; __i<nloops; __i++) {
            __callCount += 1;
            __fn();
            if ((__callCount & 0xFFF) === 0 && __timedRun && fptime() >= __stopTime) break;
        }
        __t2 = fptime();

        var __duration = (__t2 - __t1 - __timerOverhead - (__loopOverhead * __callCount * 0.000001));
        if (__timedRun) {
            // TODO: when timed, a 92m/s test is reported as running 20-30% slower than when counted
            var timedRunOverhead = (Math.floor(__callCount / 4096) + 1) * __timerOverhead;
            __duration -= timedRunOverhead;
        }
        if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, (__t2 - __t1), msg ? msg : "");

        return {count: __callCount, elapsed: __duration, wallclock: __t2 - __t1 };
    }
    else {
        var __t1, __depth;
        maybeCalibrateCb(function() {
            __fn( function() {
                // timed test begins here, called after __fn has been precompiled
                __nleft = nloops;
                __depth = 0;
                __t1 = fptime();
                __launchNext();
            });
        });

        function __launchNext() {
            if (__nleft) {
                __nleft -= 1;
                __depth += 1;
                __callCount += 1;
                __fn(__onTestDone);
            }
            else {
                __t2 = fptime();
                var __duration = (__t2 - __t1 - (__timerOverhead > 0 ? __timerOverhead : 0) - (__loopOverheadCb * __callCount * 0.000001));
                if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, (__t2 - __t1), msg ? msg : "");
                callback(null, __callCount, __duration, __t2 - __t1);
            }
        }
        function __onTestDone() {
            if (__depth > 100) { __depth = 0; setImmediate(__launchNext); }
            else __launchNext();
        }

    }
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
        var lines = results.stderr.toString().replace(',', '').split('\n');
        var cycles, ms;
        for (var i=0; i<lines.length; i++) {
            if (lines[i].indexOf(' cycles ') > 0) cycles = parseFloat(lines[i].replace(/,/g, ''));
            if (lines[i].indexOf(' task-clock ') > 0) ms = parseFloat(lines[i]);
        }
        return cycles / ms / 1000;
    }
    catch (err) {
        return false;
    }
}

function sysinfo( ) {
    function maxSpeed(cpus) {
        var mhz = 0;
        for (var i=0; i<cpus.length; i++) if (cpus[i].speed > mhz) mhz = cpus[i].speed;
        return mhz;
    }
    var cpuMhz = Math.round(measureCpuMhz() + .5) || maxSpeed(os.cpus())+"[os]";
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
                console.log("negative runtime not summed");
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

    function calibrateLoopCount( test, cb ) {
        var loops = [ 1, 5, 10, 50, 100, 500, 1000, 5e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6, 1e7, 5e7 ];
// TODO: instead of trying counts, time nloops = 1, estimate 0.05 sec, time estimated .01 sec, re-estimate
        var t1, t2, nloops = 1, ret;
        if (!cb) {
            timeit(1, test, '/* NOOUTPUT */');
            for (var i=0; i<loops.length; i++) {
                nloops = loops[i];
                t1 = timeit.fptime();
                ret = timeit(nloops, test, '/* NOOUTPUT */');
                t2 = timeit.fptime();
                var duration = t2 - t1;
                if (ret.elapsed > 0.01 || duration > 0.01) break;
            }
            return 10 * nloops;
        }
        else {
            var i = 0;
            timeit(10, test, '/* NOOUTPUT */', function(err) {
                repeatWhile(
                    function() {
                        return (i < loops.length);
                    },
                    function(next) {
                        nloops = loops[i];
                        // note that callbacked timeit re-calibrates on each call, so picking a loop count is slow (2 sec)
                        timeit(nloops, test, '/* NOOUTPUT */', function(err, callCount, cpuTime, realTime) {
                            i++;
                            // fake an error when time to stop the repeatWhile loop
                            next(cpuTime > 0.02 || realTime > 0.05);
                        })
                    },
                    function(err) {
                        // callbacked runs have higher overhead, amortize with more loops
                        cb(null, 4 * nloops);
                    }
                );
            });
        }
    }

    function runTest( timeGoal, test, cb ) {
        var startTime = timeit.fptime();
        var endTime;
        var results = [];

        if (!cb) {
            var tm = timeit.fptime(); test(); tm = timeit.fptime() - tm;
            var nloops = calibrateLoopCount(test);
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
            calibrateLoopCount(test, function(err, nloops) {
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
                        cb(null, digest);
                    }
                )
            });
        }
    }

    var timeGoal = bench.timeGoal || 4.00;
    var baselineAvg = bench.baselineAvg || undefined;
    var opsPerTest = bench.opsPerTest || 1;
    var visualize = bench.visualize || false;
    var forkTests = bench.forkTests || false;
    var isForked = Boolean(process.env._QTIMEIT_TEST);
    // TODO: pick verbosity levels, verbosity ctl syntax
    var verbose = bench.verbose || 2;
    var showSource = bench.showSource !== undefined ? bench.showSource : verbose >= 4;
    var showPlatformInfo = bench.showPlatformInfo !== undefined ? bench.showPlatformInfo : verbose >= 1;
    var showTestInfo = bench.showTestInfo !== undefined ? bench.showTestInfo : verbose >= 3;
    var showRunDetails = bench.showRunDetails !== undefined ? bench.showRunDetails : true;
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
                next();
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
        console.log("%s%s %s ops/sec %s%s%s %s",
            padRight(name, ' ', nameColumnWidth), spacer, padLeft(number_format(res.avg >>> 0), ' ', opsColumnWidth),
            metaColumn,
            '',
            padLeft('' + rank, ' ', rankColumnWidth),
            str_repeat(bargraphStr, Math.round(5 * rank / 1000)));
    }

    function composeMetaInfo( name, test, res, res0 ) {
        var meta = util.format("(%d runs of %s calls in %s out of %s sec, +/- %s%%)",
            res.runs, number_scale(res.nloops), formatFloat(res.elapsed, 3), formatFloat(res.duration, 3),
            formatFloat((res.max - res.min)/2/res.avg * 100, 2)
        );
        return meta;
    }
}
