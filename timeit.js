/**
 * High-resolution function call timer.
 *
 * Copyright (C) 2014 Andras Radics
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
module.exports.benchTimeGoal = 4.00;


if (!global.setImmediate) global.setImmediate = function(a, b, c) { process.nextTick(a, b, c) };

function fptime() {
    // note: how trustworthy is hrtime?
    //return Date.now() * 0.001;
    var t = process.hrtime();
    return t[0] + t[1] * 0.000000001;
}

function repeatWhile( test, visitor, callback ) {
    if (test()) {
        visitor(function(err){
            if (err) return callback(err);
            else setImmediate(function(){ repeatWhile(test, visitor, callback) });
        });
    }
    else return callback();
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
function dummy( ) { }
function calibrate( ) {
    var i, t1, t2;

    // turn off calibration for our internal timeit() runs
    __timerOverhead = -1;

    // Note: for calibration, x = [1,2,3] runs at 91-92m/s and x = new Array() at 74-75m/s
    // Remember to subtract out loop overhead (.15 sec per 100m) and node startup (.05 sec).
    // Note: node optimizes and de-optimizes functions on the fly.  Need to also
    // time the de-optimized version, and get a sense of the split between them.

    // warm up cache
    for (i=0; i<2000; i++) fptime();
    timeit(1000000, ";", '/* NOOUTPUT */');

    // time fptime overhead
    t1 = fptime();
    for (i=0; i<5000; i++) t2 = fptime();
    __timerOverhead = (t2 - t1) / 5000;

    // time test overhead without callback, per million calls
    t1 = fptime();
    timeit(4000000, ";", '/* NOOUTPUT */');
    t2 = fptime();
    __loopOverhead = (t2 - t1) / 4;

    // disable optimization of this function
    try { } catch (e) { }

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

    var saveTimerOverhead = __timerOverhead;
    __timerOverhead = -1;
    for (var i=0; i<1000; i++) timeit(10, function(cb){ cb() }, '/* NOOUTPUT */', function(){});

    // time test overhead with callback, per million calls
    var t1 = fptime();
    timeit(nloops, function(cb){ cb() }, '/* NOOUTPUT */', function(){
        var t2 = fptime();
        __loopOverheadCb = (t2 - t1) / (nloops / 1000000);
        __timerOverhead = saveTimerOverhead;
        cb();
    });

    // disable optimization of this function
    try { } catch (e) { }

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
        if (callback) callback(null, 0, 0);
        return { count: 0, elapsed: 0 };
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
    }

    // disable optimization of this function.  Its overhead is subtracted out,
    // and optimization would make the overhead less predictable.
    try { } catch (e) { }

    // TODO: try calibrating every run, instead of just once at the very start.
    if (__timerOverhead === undefined) {
        // calibrate, then use the measured overhead to re-calibrate more accurately
        calibrate();
        calibrate();
        calibrate();
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
            // TODO: timed runs are reported as running 20-30% slower than counted runs
            var timedRunOverhead = (Math.floor(__callCount / 4096) + 1) * __timerOverhead;
            __duration -= timedRunOverhead;
        }
        if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, (__t2 - __t1), msg ? msg : "");

        return {count: __callCount, elapsed: __duration };
    }
    else {
        function maybeCalibrate(cb) {
            if (__timerOverhead >= 0) calibrateCb(nloops < Infinity ? nloops : 4000000, cb);
            else cb();
        }
        maybeCalibrate(function() {
            // if callback is specified, chain the calls to not run them in parallel
            // run __fn twice to prime the v8 compiler, then run the timed test
            __fn( function() {
                __fn( function() {
                    // timed test begins here, called after two runs of __fn
                    __nleft = nloops;
                    var __depth = 0;
                    var __t1 = fptime();
                    __launchNext();
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
                            callback(null, __callCount, __duration);
                        }
                    }
                    function __onTestDone() {
                        if (__depth > 500) { __depth = 0; setImmediate(__launchNext); }
                        else __launchNext();
                    }
                });
            });
        });
    }
}

function runit( repeats, nloops, nItemsPerRun, name, f, callback ) {
    console.log(name);
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

function sysinfo( ) {
    var mhz = 0;
    function maxSpeed(cpus) {
        for (var i=0; i<cpus.length; i++) if (cpus[i].speed > mhz) mhz = cpus[i].speed;
        return mhz;
    }
    var sysinfo = {
        nodeTitle: process.title,               // 'node'
        nodeVersion: process.versions.node,     // '5.10.1'
        v8Version: process.versions.v8,         // '4.6.85.31'
        platform: process.platform,             // 'linux'
        arch: process.arch,                     // 'ia32'
        kernel: os.release(),                   // `uname -r`
        cpu: os.cpus()[0].model,                // `grep '^model name' /proc/cpuinfo`
        cpuMhz: maxSpeed(os.cpus()),
        cpuCount: os.cpus().length,             // `grep -c '^model name' /proc/cpuinfo`
        cpuUpThreshold: fs.readFileSync("/sys/devices/system/cpu/cpufreq/ondemand/up_threshold").toString().trim(),
    };
    return sysinfo;
}

function bench( functions, callback ) {
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

    function calibrateLoopCount( test ) {
        var loops = [ 1, 5, 10, 50, 100, 500, 1000, 5e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6, 1e7, 5e7 ];
        timeit(1, test, '/* NOOUTPUT */');
        var t1, t2, nloops = 1, ret;
        for (var i=0; i<loops.length; i++) {
            nloops = loops[i];
            t1 = timeit.fptime();
            ret = timeit(nloops, test, '/* NOOUTPUT */');
            t2 = timeit.fptime();
            var duration = t2 - t1;
            if (ret.elapsed > 0.04 || duration > 0.10) break;
        }
//console.log("AR: calibrate nloops:", duration, nloops);
        return 10 * nloops;
    }

    function runTest( test, cb ) {
        var timeGoal = +module.exports.benchTimeGoal || 4.00;
        var startTime = timeit.fptime();
        var endTime = timeit.fptime() + timeGoal;
        var results = [];

        if (!cb) {
            var tm = timeit.fptime(); test(); tm = timeit.fptime() - tm;
            var nloops = calibrateLoopCount(test);
            do {
                var result = timeit(nloops, test, "/* NOOUTPUT */");
                results.push(result);
            } while (timeit.fptime() < endTime);
//console.log(results.slice(0, 5));
            var duration = timeit.fptime() - startTime;
            var digest = computeDigest(results);
            digest.duration = duration;
            digest.nloops = nloops;
            return digest;
        }
        else {
            // TODO: callbacked version
        }
    }

    var sys = sysinfo();
    var results = [];
    var tests = {};
    if (Array.isArray(functions)) for (var i=0; i<functions.length; i++) tests['#'+(i+1)] = functions[i];
    else tests = functions;
    console.log('node=%s arch=%s mhz=%d cpu="%s" up_threshold=%d',
        sys.nodeVersion, sys.arch, sys.cpuMhz, sys.cpu, sys.cpuUpThreshold);
    console.log('name  speed  (stats)  rate');
    for (var name in tests) {
        var res = runTest(tests[name]);
        results.push({ name: name, results: res });
        console.log("%s  %s k/s (%d runs of %s in %s of %ss, +/- %d%%) %d",
            name, number_format((res.avg / 1000 + 0.5) >>> 0),
            res.runs, number_scale(res.nloops), formatFloat(res.elapsed, 3), formatFloat(res.duration, 3), formatFloat((res.max - res.min)/2/res.avg * 100, 2),
            ((1000 * res.avg / results[0].results.avg + 0.5) >>> 0));
    }

//console.log(sys);
//console.log(results);
}
