var timeit = require('./');

module.exports = {
    'should export timeit, reportit and fptime': function(t) {
        t.equal('function', typeof timeit);
        t.equal('function', typeof timeit.reportit);
        t.equal('function', typeof timeit.fptime);
        t.done();
    },

    'fptime should return floating-point monotonically increasing values': function(t) {
        var i, times = [];
        for (i = 0; i < 10000; i++) times.push(timeit.fptime());
        for (i=1; i<times.length; i++) t.ok(times[i-1] <= times[i]);
        t.done();
    },

    'timeit should time function': function(t) {
        var ncalls = 0;
        timeit(1000000, function(){ ncalls += 1 }, '/* NOOUTPUT */');
        t.ok(ncalls >= 1000000);
        t.done();
    },

    'timeit should time functions with callback': function(t) {
        t.expect(1);
        var ncalls = 0;
        timeit(1000000, function(cb){ ncalls += 1; cb(); }, '/* NOOUTPUT */', function(){
            t.ok(ncalls >= 1000000);
            t.done();
        });
    }
};
