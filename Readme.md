qtimeit
=======

Simple performance profiling tool for both synchronous and asynchronous functions.

- self-calibrating, can time the speed of even the fastest nodejs operations
- can measure functions taking a callback
- supports comparative benchmarking of a suite of test functions

Calibrates and measures by repeatedly running the test function.


Overview
--------

        var x, y;
        var timeit = require('qtimeit');
        var benchmark = require('benchmark');

Benchmarking with qtimeit

        timeit.bench([
            function() { x = [1, 2, 3]; },
            function() { x = [1, 2, 3]; y = [4, 5, 6]; }
        ]);
        // #1  93,246,313 / sec (31 runs of 5m in 1.662 over 4.382s, +/- 1.93%) 1000
        // #2  46,234,886 / sec (22 runs of 5m in 2.379 over 4.117s, +/- 1.6%) 496

        timeit(40000000, function(){ x = [1, 2, 3]; });
        // "function (){ x = [1,2,3] }": 400000000 loops in 4.2740 of 10.53 sec: 93588919.12 / sec, 0.000011 ms each

Benchmarking with benchmark

        new benchmark.Suite()
            .add(function() { x = [1, 2, 3]; })
            .add(function() { x = [1, 2, 3]; y = [4, 5, 6]; })
            .on('cycle', function(ev) {
                console.log(ev.target.toString())
            })
            .run();
        // <Test #1> x 38,281,069 ops/sec ±0.93% (92 runs sampled)
        // <Test #2> x 25,866,187 ops/sec ±1.48% (93 runs sampled)


Benchmarking from the command line to vet the results

        # node startup and loop overhead
        % time node -p 'var x; for (var i=0; i<100000000; i++) ;'
        0.208u 0.000s 0:00.21 95.2%     0+0k 0+0io 0pf+0w

        # total time for [1,2,3]
        % time node -p 'var x; for (var i=0; i<100000000; i++) x = [1,2,3];'
        1.292u 0.000s 0:01.29 100.0%    0+0k 0+0io 0pf+0w

        # total time for both [1,2,3] and [4,5,6]
        % time node -p 'var x, y; for (var i=0; i<100000000; i++) { x = [1,2,3]; y = [4,5,6]; }'
        2.348u 0.004s 0:02.35 99.5%     0+0k 0+0io 0pf+0w

        # operations per second
        % echo '100000000 / (1.29 - .21)' | bc
        92592592
        % echo '100000000 / (2.35 - .21)' | bc
        46728971


Api
---

### timeit( countOrSeconds, testFunction(), [message] )
### timeit( countOrSeconds, testFunction(cb), [message,] callback )

Call the testFunction `count` times, and report on its performance.
If the testFunction is a string it will be parsed into a function object.

If `count` is a decimal (has a fraction), the test will be looped for that many
seconds instead.  The report will include the actual number of loops run.

If a message is provided, it will be included at the start of the report line.

If a callback is provided the user-provied callback will be called after the test
has been run `count` times.  The testFunction itself will be invoked with a
callback that the test must call for timeit to finish.

        timeit = require('timeit');

        var x;
        timeit(10000000, function(){ x = [1, 2, 3]; });
        // => 10000000 loops in 0.1052 sec: 95017447.75 / sec

        timeit(10000000, function(){ x = new Array(3); });
        // => 10000000 loops in 0.1310 sec: 76345256.78 / sec

### timeit.bench( suite [,callback] )

Run each of the functions in the suite and report timings and relative throughput.
The suite can be an array of functions, or an object where the properties are
test functions and the property names are the test names to report on.

Bench works with both synchronous (no callback) and asynchronous (yes callback)
functions.


        $ node -p 'var x; var timeit = require("qtimeit");
        >   timeit.bench([
        >     function(){ x = [1,2,3] },
        >     function(){ x = new Array(3) }
        >   ]);'

        node=5.10.1 arch=ia32 mhz=3500 cpu="AMD Phenom(tm) II X4 B55 Processor" up_threshold=11
        name  speed  (stats)  rate
        #1  95,667,718 / sec (28 runs of 5m in 1.463 over 4.033s, +/- 3.84%) 1000
        #2  75,944,758 / sec (28 runs of 5m in 1.843 over 4.122s, +/- 1.18%) 794

The reported fields are the test name (`#1` etc, or the property name from the suite
object), the test speed in calls / second, statistics about the test runs (count of
timeit runs, timeit nloops, seconds used by the tests, total seconds elapsed, speed
run-to-run variability), and the normalized call rate.  The normalized call rate is
the relative speed rank of each test.  The first test is always 1000, the other tests
are proportionately higher if they ran more calls, or lower if they ran fewer calls
per second than the first test.  (E.g. above: 75,945k / 95,668k = 0.7938, ie "794"
compared to the first test's "1000".)


Accuracy
--------

It is possible to spot-check the reported rates from the command line, eg (with csh)

        % time node -p 'var x; for (var i=0; i<100000000; i++) ;'
        undefined
        0.212u 0.000s 0:00.21 100.0%    0+0k 0+0io 0pf+0w

        % time node -p 'var x; for (var i=0; i<100000000; i++) x = [1,2,3];'
        [ 1, 2, 3 ]
        1.296u 0.012s 0:01.30 100.0%    0+0k 0+0io 0pf+0w

        % echo '100000000 / (1.30 - .21)' | bc
        91743119


Notes on Timing
---------------

Qtimeit tries to be careful about self-calibrating and subtracting its own overhead
from the measured results.  The time to invoke the test function is not included as
part of the reported time, only the time to run its body.  (For very fast-running
function this can result in absurd or even negative rates, because node timing is
affected by the state of the heap and thus not overly deterministic.  Sometimes the
function body may have been optimized away, so make sure the test has a side-effect
so it cannot be skipped.)

To avoid potentially misleading timings, also run the test on just a single cpu.
Nodejs will at times run with multiple internal threads active that use more than
100% total cpu.  This can be defeated by forcing the test to run on a single core.
On Linux this can be done with the `taskset` command.

When timing, be aware that modern cpus make performance profiling tricky, because
the actual cpu speed can vary and may not be known.

- by default the cpu will be in power-save (slow) mode
- it takes some amount computation to bring the cpu out of slow mode
- with just one core active, the cpu will run in turbo (extra-fast) mode
- with multiple cores active, the cpu can switch to a slower turbo mode
- if the core temperature reaches an internal threshold, turbo mode might end

On Linux, these can be controlled somewhat by setting the scaling_governor to
`performance` (always fast) one one of the cores, then running the test on that
core.  Eg, for core 3:

        $ echo -n performance > /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor
        $ taskset 4 node test.js

(/sys/devices/system/cpu numbers cpus starting at 0.  The `taskset` core number is
a bitmask starting at 1, so core1 = 1, core2 = 2, core3 = 4, core4 = 8, etc.  The
bitmask values can be added to specify any one of a set of cores.)


Todo
----

- tiny command line one-liners can run out of cache and give inflated results
- need a way to force deoptimization so can time deoptimized version too
