qtimeit
=======

Time which version of the code runs faster.

        timeit = require('timeit');

        var x;
        timeit(10000000, function(){ x = [1, 2, 3]; });
        // => 10000000 loops in 0.1052 sec: 95017447.75 / sec

        timeit(10000000, function(){ x = new Array(3); });
        // => 10000000 loops in 0.1310 sec: 76345256.78 / sec


Api
---

### timeit( count, testFunction(), [message] )

Call the testFunction `count` times, and report on its performance.
If the testFunction is a string it will be parsed into a function object.

If `count` is a decimal (has a fraction), the test will be looped for that many
seconds instead.  The report will include the actual number of loops run.

If a message is provided, it will be included at the start of the report line.


### timeit( count, testFunction(cb), [message,] callback )

If a callback is provided the user-provied callback will be called after the test
has been run `count` times.  The testFunction itself will be invoked with a
callback that the test must call for timeit to finish.


Notes on Timing
---------------

Qtimeit tries to be careful about self-calibrating and subtracting its own overhead
from the measured results.  The time to invoke the test function is not included as
part of the reported time, only the time to run its body.  (For very fast-running
function this can result in absurd or even negative rates, because node timing is
affected by the state of the heap and thus not overly deterministic.)

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
