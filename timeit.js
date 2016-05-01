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

if (!global.setImmediate) global.setImmediate = function(a, b, c) { process.nextTick(a, b, c) };

function fptime() {
    // note: how trustworthy is hrtime?
    //return Date.now() * 0.001;
    var t = process.hrtime();
    return t[0] + t[1] * 0.000000001;
}

// 0.01357 => 0.014
function formatFloat( value, decimals ) {
    var power = 1, sign = '';
    // convert to fixed-point, make string, and insert decimal point
    // handle sign separately to round toward zero
    if (value < 0) { sign = '-'; value = -value; }
    for (var i = 0; i < decimals; i++) power *= 10;
    var digits = Math.floor(value * power + 0.5).toString();
    // right-pad the fraction with trailing zeroes as needed
    while (digits.length <= decimals) digits = "0" + digits;
    return sign + digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}

// print run timing results
function reportit( f, nloops, __duration, msg ) {
    var __rate = nloops/__duration;
    var m1 = (msg ? msg+" " : "")
    process.stdout.write((msg ? msg+" " : "") + '"' + f + '": ');
    process.stdout.write(nloops + " loops in " + formatFloat(__duration, 4) + " sec: ");
    process.stdout.write(formatFloat(__rate, 2) + " / sec, " + formatFloat(__duration/nloops*1000, 6) + " ms each");
    process.stdout.write("\n");
}

var __timerOverhead;            // ms to make 1 fptime call
var __loopOverhead;             // ms to make 1000 test function calls
var __loopOverheadCb;           // ms to make 1000 test function calls with callback
function dummy( ) { }
function calibrate( ) {
    var i, t1, t2;

    // turn off calibration for our internal timeit() runs
    __timerOverhead = -1;

    // warm up cache
    for (i=0; i<2000; i++) fptime();
    timeit(1000000, ";", '/* NOOUTPUT */');

    // time fptime overhead
    t1 = fptime();
    for (i=0; i<5000; i++) t2 = fptime();
    __timerOverhead = (t2 - t1) / 5000;

    // time test overhead without callback
    t1 = fptime();
    timeit(4000000, ";", '/* NOOUTPUT */');
    t2 = fptime();
    __loopOverhead = (t2 - t1) / 4;

    // time test overhead with callback
    t1 = fptime();
    timeit(4000000, function(cb){ }, '/* NOOUTPUT */');
    t2 = fptime();
    __loopOverheadCb = (t2 - t1) / 4;

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
    if (typeof msg === 'function') { callback = msg; msg = undefined; }

    if (nloops !== null && nloops <= 0) {
        if (callback) callback(null, 0, 0);
        return;
    }

    // if the loop count is a decimal, repeat for that many seconds
    if (nloops !== (nloops | 0)) {
        setTimeout(function(){
            nloops = __callCount;
            __nleft = 0;
        }, (nloops * 1000) | 0);
        nloops = Infinity;
    }

    // disable optimization of this function.  Its overhead is subtracted out,
    // and optimization would make the overhead less predictable.
    try { } catch (e) { }

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
        for (__i=0; __i<nloops; ++__i) {
            __callCount += 1;
            __fn();
        }
        __t2 = fptime();

        var __duration = (__t2 - __t1 - __timerOverhead - (__loopOverhead * __callCount * 0.000001));
        if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, msg ? msg : "");
    }
    else {
        // if callback is specified, chain the calls to not run them in parallel
        // run __fn twice to prime the v8 compiler, then run the timed test
        __fn( function() {
            __fn( function() {
                // timed test begins here, called after two runs of __fn
                __nleft = nloops;
                var __depth = 0;
                var __t1 = fptime();
                (function __launchNext() {
                    if (__nleft) {
                        __nleft -= 1;
                        __depth += 1;
                        __callCount += 1;
                        __fn(function(){
                            // TODO: only loops 15m/s, vs the above 150m/s
                            if (__depth > 500) { __depth = 0; setImmediate(__launchNext); }
                            else __launchNext();
                        });
                    }
                    else {
                        __t2 = fptime();
                        var __duration = (__t2 - __t1 - __timerOverhead - (__loopOverheadCb * __callCount * 0.000001));
                        if (msg !== '/* NOOUTPUT */') reportit(f, __callCount, __duration, msg ? msg : "");
                        callback(null, __callCount, __duration);
                    }
                })();
            });
        });
    }
}

function runit( repeats, nloops, nItemsPerRun, name, f, callback ) {
    console.log(name);
    var j = 0;
    var t1, t2, min, max;
    var totalCallCount = 0, totalRunTime = 0, totalElapsedTime = 0;
    function repeatWhile( test, visitor, callback ) {
        if (test()) {
            visitor(function(err){
                if (err) return callback(err);
                else setImmediate(function(){ repeatWhile(test, visitor, callback) });
            });
        }
        else return callback();
    }
    repeatWhile(
        function() {
            return j++ < repeats;
        },
        function(next) {
            t1 = timeit.fptime();
            timeit(nloops, f, function(err, ncalls, elapsed) {
                t2 = timeit.fptime();
                totalElapsedTime += t2 - t1;
                if (min === undefined || elapsed < min) min = elapsed;
                if (max === undefined || elapsed > max) max = elapsed;
                totalCallCount += ncalls;
                totalRunTime += elapsed;
                next(err);
            });
        },
        function(err) {
            // item processing rate, adjusted for the 1 calibration run made by timeit()
            var rateMin = totalCallCount * nItemsPerRun / repeats / max             * ((totalCallCount + 1) / totalCallCount);
            var rateMax = totalCallCount * nItemsPerRun / repeats / min             * ((totalCallCount + 1) / totalCallCount);
            var rateAvg = totalCallCount * nItemsPerRun / repeats / (totalRunTime / repeats) * ((totalCallCount + 1) / totalCallCount);
            console.log("Total runtime %s of %s elapsed", formatFloat(totalRunTime, 3), formatFloat(totalElapsedTime, 3));
            console.log("item rate min-max-avg %s %s %s", formatFloat(rateMin, 2), formatFloat(rateMax, 2), formatFloat(rateAvg, 2));
            if (err) throw err;
            if (callback) callback();
        }
    );
}
