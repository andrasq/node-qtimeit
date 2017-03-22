qtimeit
=======

Simple performance profiling tool for both synchronous and asynchronous functions,
usable to micro-benchmark nodejs language features.

- sensitive enough to time even really fast nodejs operations
- measures just the body of the test function, not the function call
- self-calibrating, does not include its own overhead in the results
- auto-calibrating, can run tests for a specified number of seconds
- works with both synchronous functions and functions taking a callback
- allows comparative benchmarking a suite of test functions

Calibrates and measures by repeatedly running the test function, so avoid
unintended side effects.


Overview
--------

Examples of a one-off micro benchmark and a benchmark suite

    var x, y;
    var timeit = require('qtimeit');

    timeit(10000000, function(){ x = [1, 2, 3]; });
    // => 10000000 loops in 0.1095 of 0.27 sec: 91299026.24 / sec, 0.000011 ms each

    timeit.bench([
        function() { x = [1, 2, 3]; },
        function() { x = [1, 2, 3]; y = [4, 5, 6]; }
    ]);
    // #1  93,468,158 ops/sec (31 runs of 5m calls in 1.658 out of 4.373 sec, +/- 2.16%) 1000
    // #2  47,414,812 ops/sec (22 runs of 5m calls in 2.320 out of 4.059 sec, +/- 1.94%) 507


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


    var x, timeit = require('timeit');
    timeit(10000000, function(){ x = [1, 2, 3]; });
    // => 10000000 loops in 0.1095 of 0.27 sec: 91299026.24 / sec, 0.000011 ms each

    timeit(10000000, function(cb) { x = [1, 2, 3]; cb() }, function(){});
    // => 10000000 loops in 0.1107 of 0.52 sec: 90337752.78 / sec, 0.000011 ms each

### timeit.bench( suite [,callback] )

Run each of the functions in the suite and report timings and relative throughput.
The suite can be an array of functions, or an object where the properties are
test functions and the property names are the test names to report on.

Bench works with both synchronous (no callback) and asynchronous (yes callback)
functions.


    var x, timeit = require('qtimeit');
    timeit.bench([
        function() { x = [1, 2, 3]; },
        function() { x = [1, 2, 3]; y = [4, 5, 6]; }
    ]);
    // node=5.10.1 arch=ia32 mhz=3500 cpu="AMD Phenom(tm) II X4 B55 Processor" up_threshold=11
    // name  speed  (stats)  rate
    // #1  93,468,158 / sec (31 runs of 5m in 1.658 over 4.373s, +/- 2.16%) 1000
    // #2  47,414,812 / sec (22 runs of 5m in 2.320 over 4.059s, +/- 1.94%) 507


The reported fields are the test name (`#1` etc, or the property name from the suite
object), the test speed in calls / second, statistics about the test runs (count of
timeit runs, timeit nloops, seconds used by the tests, total seconds elapsed, speed
run-to-run variability), and the normalized call rate.  The normalized call rate is
the relative speed rank of each test.  The first test is always 1000, the other tests
are proportionately higher if they ran more calls, or lower if they ran fewer calls
per second than the first test.  (E.g. above: 47,415k / 93,468k = 0.5072, ie "507"
compared to the first test's "1000".)

#### timeit.bench.timeGoal

How long to loop the each test before computing the average.  Default 4.00 seconds.

#### timeit.bench.opsPerTest

How many operations are performed in each test function, for when the tests
themselves loop.  The number of ops/sec reported in the summary will be scaled up
by this value.  Default 1.

#### timeit.bench.cpuMhz

The processor speed to report in the platform summary line, in MHz.  Qtimeit tries
to self-calibrate using /usr/bin/perf on linux systems, but calibration is not
perfect, and can under-report the speed.  If calibration fails `qtimeit` normally
reports the unreliable figure included in `os.cpus()`.

### timeit.fptime( )

Nanosecond-resolution floating-point timestamp from process.hrtime().  The
timestamp returned does not have an absolute meaning (on Linux, it's `uptime(1)`,
the number of seconds since the last boot), but differeces between timestamps
are accurate -- a difference of 1.00 is 1 elapsed second.  The overhead is as
low as .6 microseconds per call, about 3x slower than Date.now().

        var fptime = require('arlib/timeit').fptime
        var t1 = fptime();      // 1809688.215437152
        var t2 = fptime();      // 1809688.215462518
        var t3 = fptime();      // 1809688.215466353
        // 25.4 usec for the first call, 3.84 for the second
        // uptime of 20 days, 22:40 hours

### timeit.cpuMhz( )

Measure the speed of the processor using `perf stat ...`.  Works on Linux, not sure
about other platforms.  Returns a float eg `4522.5421`, else `false` if unable to
measure.

### timeit.sysinfo( )

Return the information block that is also prepended to `qtimeit.bench` test runs.
This includes the node and v8 versions, the system architecture, and the cpu make,
model and speed in MHz.

Comparisons
-----------

Testing with node-v5.10.1 (which on this test is 25% faster than node-v6.2.2):

Benchmarking with `qtimeit` (from above)

    var x, timeit = require('qtimeit');
    timeit.bench([
        function() { x = [1, 2, 3]; },
        function() { x = [1, 2, 3]; y = [4, 5, 6]; }
    ]);
    // #1  93,468,158 / sec (31 runs of 5m in 1.658 over 4.373s, +/- 2.16%) 1000
    // #2  47,414,812 / sec (22 runs of 5m in 2.320 over 4.059s, +/- 1.94%) 507

Benchmarking with `benchmark`

    var x, y, benchmark = require('benchmark');
    new benchmark.Suite()
        .add(function() { x = [1, 2, 3]; })
        .add(function() { x = [1, 2, 3]; y = [4, 5, 6]; })
        .on('cycle', function(ev) {
            console.log(ev.target.toString())
        })
        .run();
    // <Test #1> x 38,281,069 ops/sec ±0.93% (92 runs sampled)
    // <Test #2> x 25,866,187 ops/sec ±1.48% (93 runs sampled)

Benchmarking with `bench`

    var x, y, bench = require('bench');
    module.exports.compare = {
        'one array':  function() { x = [1, 2, 3]; },
        'two arrays': function() { x = [1, 2, 3]; y = [4, 5, 6]; },
    };
    bench.runMain();
    // one array
    // Average (mean) 53302.44755244756
    // two arrays
    // Average (mean) 33285.46453546454

The two last sets of reported rates seem wrong:  allocating two arrays is twice as
much work thus should run at half the speed (take twice as long) as allocating just
one.  The rates are also much lower than the `qtimeit.bench`-reported 93m and 47m
operations per second.

Sometimes it's possible to double-check the accuracy of the reported speeds from
short scripts or even from the command line.  So let's re-measure the rates with a
barebones timed loop:

    # node startup and loop overhead
    % time node -p 'var x; for (var i=0; i<100000000; i++) ;'
    0.208u 0.000s 0:00.21 95.2%     0+0k 0+0io 0pf+0w

    # total time for [1,2,3]
    % time node -p 'var x; for (var i=0; i<100000000; i++) x = [1,2,3];'
    1.292u 0.000s 0:01.29 100.0%    0+0k 0+0io 0pf+0w

    # total time for both [1,2,3] and [4,5,6]
    % time node -p 'var x, y; for (var i=0; i<100000000; i++) { x = [1,2,3]; y = [4,5,6]; }'
    2.348u 0.004s 0:02.35 99.5%     0+0k 0+0io 0pf+0w

    # operations per second for the one array and two arrays
    % echo '100000000 / (1.29 - .21)' | bc
    92592592
    % echo '100000000 / (2.35 - .21)' | bc
    46728971

Raw: 92.59m/s.  Benchmark: 38.28m/s, 142% off.  Bench: 53.30m/s, 74% off.
Qtimeit: 93.47m/s, 1% off.


Notes on Timing
---------------

Qtimeit tries to be careful about self-calibrating and subtracting its own overhead
from the measured results.  The time to invoke the test function is not included as
part of the reported time, only the time to run its body.  (For very fast-running
function this can result in absurd or even negative rates, because node timing is
affected by the state of the heap and thus not overly deterministic.  Sometimes the
function body may have been optimized away, so make sure the test has a side-effect
so it cannot be skipped.)

### Cpu Effects

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
- some cpus can use super-turbo speeds faster than the preset turbo
- if the core temperature reaches an internal threshold, turbo mode might end
- very short one-liners that fit into the cpu cache can benchmark as much faster
  than when run in more realistic settings alongside other code

On Linux, these can be controlled somewhat by setting the scaling_governor to
`performance` (always fast) one one of the cores, then running the test on that
core.  Eg, for core 3:

    $ echo -n performance > /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor
    $ taskset 4 node test.js

(/sys/devices/system/cpu numbers cpus starting at 0.  The `taskset` core number is
a bitmask starting at 1, so core1 = 1, core2 = 2, core3 = 4, core4 = 8, etc.  The
bitmask values can be added to specify any one of a set of cores.)

### Nodejs Effects

Nodejs itself makes benchmarking less than straightforward

- the first `timeit()` run often reports very different numbers than a rerun,
  for some tests higher, for some lower.  The first run finds a clean heap, but
  has to allocate memory from the operating system
- the state of the heap affects timings, so changing the order of tests can change the results
- heap, garbage collection and function optimization/deoptimization effects can
  result in a large run-to-run variability
- the performance of the whole may not match that of the parts measured in isolation
- some language features (`try`/`catch`, `eval`, passing `arguments`) inentionally
  disable optimization of the immediately containing function
- some language quirks inadvertently turn off optimization (eg `const` in the middle
  of some functions)
- some latent language bugs can produce function optimize / deoptimize thrashing
  (eg in sometimes storing a constructor function arg into `this` vs setting it
  as a property on the object afterward)

Related Work
------------

- [qtimeit](http://github.com/andrasq/node-qtimeit) - this package
- [benchmark](http://npmjs.org/package/benchmark) - a popular benchmarking package, inaccurate
- [bench](http://npmjs.org/package/bench) - another benchmarking package
- [qbson](http://github.com/andrasq/node-qbson) - BSON encode/decode functions whose timings prompted `timeit.bench()`


Todo
----

- tiny command line one-liners can run out of cache and give inflated results
- need a way to force deoptimization so can time deoptimized version too
