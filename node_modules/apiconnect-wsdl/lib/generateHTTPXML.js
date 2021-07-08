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

/**
* Functions that generate an HTTP XML api
**/

const u = require('../lib/utils.js');
var _ = require('lodash');
const dictionary = require('../lib/dictionary.js');
const genDefs = require('../lib/generateDefs.js');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');

/**
* Generate HTTP XML sections of the api.
* @param serviceName name of the service for this apic
* @param globalNamespaces the global namespace map defining unique prefixes for each namespace
* @param serviceJSON
* @param dict is the Dictionary
* @param refMap is the referenced definition map
* @param options create options
* @return swagger
*/
function generateHTTPXML(serviceName, globalNamespaces, serviceJSON, dict, refMap, options) {
    let req = dict.req;

    // If multiple services of the same name were detected,
    // then the serviceName was changed to disambiguate the services
    // <serviceName>-from-<slugifiedpath>
    let originalServiceName = serviceName;
    let title = originalServiceName;
    let mangleIndex = originalServiceName.indexOf('-from-');
    if (mangleIndex > 0) {
        serviceName = originalServiceName.substring(0, mangleIndex);
    }
    // If the port was explicitly specified, then add it to the title to disambiguate from
    // services that use the default port.
    if (options.port) {
        title += ' using port ' + options.port;
    }
    let url = serviceJSON.service[0].undefined.endpoint;

    // Create the initial swagger
    let swagger = initializeSwagger(serviceName, title, 'rest', options.gateway, url);
    return swagger;
}


String.prototype.hexEncode = function() {
    var hex;

    var result = '';
    for (let i = 0; i < this.length; i++) {
        hex = this.charCodeAt(i).toString(16);
        result += ('000' + hex).slice(-4);
    }
    return result;
};

/**
* Generate the initial swagger
*/
function initializeSwagger(serviceName, title, type, gateway, url) {
    let ibmName = u.slugifyName(title);
    if (!ibmName) {
        // If no characters are valid in a slugifyName,
        // hex encode the title and use that to create an ibm name.
        ibmName = u.slugifyName('id' + title.hexEncode().substring(0, 50));
        if (!ibmName) {
            // Fail safe is to create a random string
            ibmName = u.randomAlphaString(10);
        }
    }
    // Truncate ibm name and title to reasonable length.
    // They may be used (with a version) to produce a product or other name.
    // The product (and other names) must be less than 256 chars in the portal.
    ibmName = ibmName.substring(0, 240);
    title = title.substring(0, 240);

    let swagger = {
        swagger: '2.0',
        info: {
            title: title,
            description: '',
            'x-ibm-name': ibmName,
            version: '1.0.0'
        },
        schemes: [ 'https' ],
        basePath: '/',
        produces: [ 'application/xml' ],
        consumes: [ 'text/xml' ],
        securityDefinitions: {
            clientID: {
                type: 'apiKey',
                name: 'X-IBM-Client-Id',
                in: 'header',
                description: ''
            }
        },
        security: [ {
            clientID: []
        } ],
        'x-ibm-configuration': {
            type: type,
            phase: 'realized',
            enforced: true,
            testable: true,
            gateway: 'datapower-gateway',  // Assume datapower-gateway, will modify later
            cors: {
                enabled: true
            },
            assembly: {
                execute: [ ]
            }
        },
        paths: {},
        definitions: {}
    };
    swagger['x-ibm-configuration'].assembly.execute[0] = {
        proxy: {
            title: 'proxy',
            'target-url': url
        }
    };
    return swagger;
}
exports.generateHTTPXML = generateHTTPXML;
