var timeit = require('./');

var SILENT = '/* NOOUTPUT */';          // suppress test output

module.exports = {
    'should export timeit, reportit, fptime and bench': function(t) {
        t.equal('function', typeof timeit);
        t.equal('function', typeof timeit.reportit);
        t.equal('function', typeof timeit.fptime);
        t.equal('function', typeof timeit.bench);
        t.done();
    },

    'should export sysinfo, cpuMhz': function(t) {
        t.equal('function', typeof timeit.sysinfo);
        t.equal('function', typeof timeit.cpuMhz);
        t.done();
    },

    'fptime should return floating-point monotonically increasing values': function(t) {
        var i, times = [];
        for (i = 0; i < 10000; i++) times.push(timeit.fptime());
        for (i=1; i<times.length; i++) t.ok(times[i-1] <= times[i]);
        t.done();
    },

    'timeit()': {
        'timeit should time counted function': function(t) {
            var ncalls = 0;
            timeit(1000000, function(){ ncalls += 1 }, SILENT);
            t.ok(ncalls >= 1000000);
            t.done();
        },

        'timeit should time timed function': function(t) {
            var t1 = Date.now();
            var ncalls = 0;
            timeit(0.030, function(){ ncalls += 1 }, SILENT);
            t.ok(Date.now() - t1 >= 30);
            t.done();
        },
    },

    'timeit(cb)': {
        'timeit should time counted functions with callback': function(t) {
            t.expect(1);
            var ncalls = 0;
            timeit(1000000, function(cb){ ncalls += 1; cb(); }, SILENT, function(){
                t.ok(ncalls >= 1000000);
                t.done();
            });
        },

        'timeit should time timed functions with callback': function(t) {
            t.expect(1);
            var t1 = Date.now();
            var ncalls = 0;
            timeit(0.030, function(cb){ ncalls += 1; cb(); }, SILENT, function(){
                t.ok(Date.now() - t1 >= 30);
                t.done();
            });
        },
    },

    'bench': {
    },
};
