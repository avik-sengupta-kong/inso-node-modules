/** ******************************************************* {COPYRIGHT-TOP} ***
 * Licensed Materials - Property of IBM
 * 5725-Z22, 5725-Z63, 5725-U33, 5725-Z63
 *
 * (C) Copyright IBM Corporation 2016, 2020
 *
 * All Rights Reserved.
 * US Government Users Restricted Rights - Use, duplication or disclosure
 * restricted by GSA ADP Schedule Contract with IBM Corp.
 ********************************************************** {COPYRIGHT-END} **/

'use strict';
const jsyaml = require('js-yaml');
var _ = require('lodash');
const g = require('../lib/strong-globalize-fake.js');

const ROOT = '__ROOT__';
const verbose = false;
const LIMIT = 1000;
const MEMLIMIT = 5;

function start(req, name) {
    if (!req) {
        return;
    }
    if (!req.context) {
        req.context = {
            cursors: [],
            messages: {
                detail: {},
                info: {},
                warning: {},
                error: {},
            }
        };
    }
    let context = req.context;
    let stage = newStage(context, name);
    stage.startTime = new Date().getTime();
    stage.startHeap = heapUsed();
}

function end(req, name, error) {
    if (!req) {
        return;
    }
    let context = req.context;
    let stage = context.cursors.pop();
    let prefix = indent(context);
    if (!stage) {
        detail(req, g.http(req).f('pop error for %s %s', name, error));
        return;
    }
    if (stage.name !== name) {
        stage.data.endError = new Error('Mismatch report').toString();
    } else if (error) {
        stage.data.endError = error.toString();
    }
    if (stage.data.endError) {
        detail(req, g.http(req).f('report error %s', stage.data.endError));
    }
    stage.endTime = new Date().getTime();
    stage.endHeap = heapUsed();

    stage.data.elapsedTime = stage.endTime - stage.startTime;
    if (stage.data.elapsedTime > LIMIT) {
        detail(req, g.http(req).f('Elapsed time for %s is %s.', stage.name, stage.data.elapsedTime));
    }
    if (Math.abs(stage.endHeap - stage.startHeap) > MEMLIMIT) {
        detail(req, g.http(req).f('Heap for %s (start: %s MB,  end: %s MB)', stage.name, stage.startHeap, stage.endHeap));
    }
    if (verbose && stage.data.elapsedTime > LIMIT) {
        console.log(prefix + '  data for stage ' + stage.name);
        try {
            let data = jsyaml.dump(stage.data);
            console.log(indentLines(prefix + '    ', data));
        } catch (e) {
            console.log(e);
        }
    }
    if (stage.name !== name && stage.name !== ROOT) {
        end(req, name, error);
    }
}

/**
* @return heap used (in MB)
*/
function heapUsed() {
    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
}

function detail(req, key, message, path) {
    if (!req || !req.context) {
        return;
    }
    message = message || key;
    if (!req.context.messages.detail[key]) {
        req.context.messages.detail[key] = {
            message: message
        };
        if (path) {
            req.context.messages.detail[key].$path = path;
        }
    }
}

function error(req, key, message, path) {
    key = key.stack || key;
    if (!req || !req.context) {
        return;
    }
    message = message || key;
    if (!req.context.messages.error[key]) {
        req.context.messages.error[key] = {
            message: message
        };
        if (path) {
            req.context.messages.error[key].$path = path;
        }
    }
}

function info(req, key, message, path) {
    if (!req || !req.context) {
        return;
    }
    message = message || key;
    if (!req.context.messages.info[key]) {
        req.context.messages.info[key] = {
            message: message
        };
        if (path) {
            req.context.messages.info[key].$path = path;
        }
    }
}

function warning(req, key, message, path) {
    if (!req || !req.context) {
        return;
    }
    message = message || key;
    if (!req.context.messages.warning[key]) {
        req.context.messages.warning[key] = {
            message: message
        };
        if (path) {
            req.context.messages.warning[key].$path = path;
        }
    }
}


function getMessages(req, level) {
    let messages = {
    };
    if (req && req.context && req.context.messages) {
        if (level === 'DETAIL') {
            messages.detail = _.values(req.context.messages.detail);
        }
        if (level === 'DETAIL' || level == 'INFO') {
            messages.info = _.values(req.context.messages.info);
        }
        if (level === 'DETAIL' || level == 'INFO' || level == 'WARNING') {
            messages.warning = _.values(req.context.messages.warning);
        }
        messages.error = _.values(req.context.messages.error);
    }
    return messages;
}

function indentLines(prefix, text) {
    return prefix + _.replace(text, /(\r\n|\r|\n)/g, function(s) {
        return s + prefix;
    });
}

function indent(context) {
    try {
        let w = [];
        for (let i = 1; i < context.cursors.length; i++) {
            w[i] = ' ';
        }
        return w.join(' ');
    } catch (e) {
        return '';
    }
}

function newStage(context, name) {
    let stage = {
        name: name,
        data: {},
        stages: [],
    };
    let c = cursor(context);
    if (c) {
        c.stages.push(stage);
    }
    context.cursors.push(stage);
    return stage;
}

function cursor(context) {
    if (context && context.cursors && context.cursors.length > 0) {
        return context.cursors[context.cursors.length - 1];
    }
    return null;
}


exports.start = start;
exports.end = end;
exports.error = error;
exports.info = info;
exports.warning = warning;
exports.detail = detail;
exports.getMessages = getMessages;
