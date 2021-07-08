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

const u = require('../lib/utils.js');
const parseUtils = require('../lib/parseUtils.js');
const fileUtils = require('../lib/fileUtils.js');
const d = require('../lib/domUtils.js');
const parse = require('../lib/parse.js');
const flattener = require('../lib/flatten.js');

const q = require('q');
const yauzl = require('yauzl');
const xmldom = require('xmldom');
const JSZip = require('jszip');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');

var LOCATION = 'location';
var WSDL = 'wsdl';
var SOAP = 'soap';
var PORT = 'port';
var SERVICE = 'service';
var ADDRESS = 'address';
var PORT_QN = WSDL + ':' + PORT;
var ADDRESS_QN = SOAP + ':' + ADDRESS;

/**
* @param inContent wsdl or zip content (Buffer or String)
* @param serviceEndpoints single or array of endpoint strings
* @param serviceName the wsdl-definition.service string.
* @param options
*   req: request or null (used for i18n negotiation)
* @return (Promise)
*   outContent: wsdl or zip content in a Buffer
*   filename: if zip mode, this is the full name of first wsdl modified within the zip
*   stringContent: in zip mode, this is the string content of filename.
*                  in wsdl mode, this is the string content of the wsdl file
*/
async function injectServiceEndpointsIntoWSDLorZIP(inContent, serviceEndpoints, serviceName, options) {
    options = options || {};
    serviceEndpoints = u.makeSureItsAnArray(serviceEndpoints);
    inContent = fileUtils.toBuffer(inContent, options.req);
    if (options.sanitizeWSDL) {
        inContent = await parse.sanitize(inContent, options.req);
    }
    let isZip = inContent.toString('utf8', 0, 4).substr(0, 4) === 'PK\u0003\u0004';
    if (isZip) {
        let outZip = await JSZip.loadAsync(inContent);
        let data = await setServiceEndpoint(inContent, serviceEndpoints, null, serviceName, options);
        if (!data || data.length === 0) {
            // Nothing modified (?), just return input content
            return {
                outContent: inContent
            };
        } else {
            // Update each file in the zip and generate a new Buffer
            for (let i = 0; i < data.length; i++) {
                outZip.file(data[i].filename, data[i].content);
            }
            let buffer = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
            return {
                outContent: buffer,
                filename: data[0].filename,
                stringContent: data[0].content
            };
        }
    } else {
        let data = await setServiceEndpoint(inContent.toString(), serviceEndpoints, null, null, options);
        let stringContent = data[0].content;
        return {
            outContent: fileUtils.toBuffer(stringContent, options.req),
            stringContent: stringContent
        };
    }
}

/**
* Replaces and Creates serviceEndpoints in the wsdl (filename)
* If the serviceEndpointList is one item, then the port addresses are replaced.
* If the serviceEndpointList is multiple items, then new service ports are created for
* for the subsequent endpoints.
*/
async function setServiceEndpoint(filenameOrContent, serviceEndpoints, auth, serviceName, options) {
    options = options || {};
    let req = options.req;
    serviceEndpoints = u.makeSureItsAnArray(serviceEndpoints);
    var data = [];

    /**
     * @return true if file should be ignored
     */
    function shouldIgnore(fileName) {
        // Ignore all files in the zip except wsdls (for legacy reasons assume wsdl can be in an xsd file (?))
        return !(fileUtils.isWSDL(fileName) || fileUtils.isXSD(fileName));
    }
    /**
     * Process the file contents
     * @param fileName
     * @param fileContent (this is a String with the decoded content)
     * @param originalEncoding is the original encoding of the content
     * @return { fileName: <obfuscated name> , content <obfuscated decoded content>}
     */
    function processFileContents(fileName, fileContent, req, originalEncoding) {
        let outContent = adjustPortsInFileContent(fileContent, serviceName, serviceEndpoints, req);
        if (outContent) {
            if (!isUTF8(originalEncoding)) {
                outContent = fileUtils.encode(outContent, originalEncoding);
            }
            data.push({
                filename: fileName,
                content: outContent
            });
        }
        // Return null because we won't be using the output archive, therefore we don't need to write this content to it.
        return null;
    }

    let out = await fileUtils.asContent(filenameOrContent, filenameOrContent, auth, null, req);
    var rawContent = out.content;
    if (fileUtils.isZip(rawContent)) {
        let archive = await fileUtils.asArchive(rawContent, req, options.flatten);
        await fileUtils.pipeArchive(archive, req, shouldIgnore, processFileContents);
        return data;
    } else {
        try {
            let encoding = fileUtils.determineEncoding(rawContent, filenameOrContent);
            let content = (encoding === 'utf8') ? rawContent : fileUtils.decode(rawContent, encoding);
            let decodedContent = content.toString();
            let outContent = adjustPortsInFileContent(decodedContent, serviceName, serviceEndpoints, req);
            if (outContent) {
                if (!isUTF8(encoding)) {
                    outContent = fileUtils.encode(outContent, encoding);
                }
                var file = {
                    filename: filenameOrContent.length > 200 ? 'IN_MEMORY' : filenameOrContent,
                    content: outContent
                };
                data.push(file);
            }
            return data;
        } catch (e) {
            throw fileUtils.cleanupError(e, req);
        }
    }
}

/**
* Adjusts service ports in file content
* @param inContent input decoded content
* @param serviceName service name
* @param serviceEndpoints new service endpoint(s)
* @param req I18N object
* @return outContent output decoded content or null if no changes
*/
function adjustPortsInFileContent(inContent, serviceName, serviceEndpoints, req) {
    let wsdlDoc = d.loadSafeDOM(inContent, req);
    let lookForPorts = (typeof wsdlDoc == 'object');
    if (lookForPorts && serviceName) {
        // Make sure the document has a service matching the service name
        lookForPorts = false;
        var serviceEls = wsdlDoc.documentElement.getElementsByTagNameNS(
          'http://schemas.xmlsoap.org/wsdl/', SERVICE);
        if (serviceEls) {
            for (let s = 0; s < serviceEls.length; s++) {
                if (serviceEls[s].getAttribute('name') === serviceName) {
                    lookForPorts = true;
                }
            }
        }
    }
    if (lookForPorts) {
        var portEls = wsdlDoc.documentElement.getElementsByTagNameNS(
          'http://schemas.xmlsoap.org/wsdl/', PORT);
        var isModified = false;
        var portLen = portEls.length;
        for (var i = 0; i < portLen; i++) {
            if (adjustPort(portEls.item(i), serviceEndpoints)) {
                isModified = true;
            }
        } // end for

        if (isModified) {
            var serializer = new xmldom.XMLSerializer();
            return serializer.serializeToString(wsdlDoc);
        }
    }
    return null;
}

function isUTF8(encoding) {
    return encoding.toLowerCase() === 'utf8' || encoding.toLowerCase() === 'utf-8';
}

/**
 * Change the addresses in the port to the first service endpoint.
 * For subsequent addresses, create and add new ports
 * @method adjustPort
 * @param Node port - port Port that requires adjustment and possible duplication
 * @param String[] - serviceEndpoints - Service Endpoints
 * @return boolean - true if any modifications are made
 */
function adjustPort(port, serviceEndpoints) {
    var isModified = false;
    if (serviceEndpoints.length > 0) {

    // Get children of port
        var children = port.getElementsByTagName('*');
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            // If this is an address element (an kind soap, wsdl, etc) then replace the location
            if (child.localName == ADDRESS) {
                if (child.hasAttribute(LOCATION)) {
                    child.setAttribute(LOCATION, serviceEndpoints[0]);
                    isModified = true;
                }
            }
        }

        // If there is more than one endpoint then duplicate the port and addresses
        if (isModified && serviceEndpoints.length > 1) {
            for (var j = 1; j < serviceEndpoints.length; j++) {
                var serviceEndpoint = serviceEndpoints[j];
                // Clone the port and change the name
                var newPort = port.cloneNode(true);
                var portName = port.getAttribute('name') + '_' + (j + 1);
                newPort.setAttribute('name', portName);

                // Add the node
                // (best practice is to use the node returned from appendChild because DOM is allowed to return a different Object
                // but in practice it usually returns the same object).
                newPort = port.parentNode.appendChild(newPort);

                // Adjust the locations
                children = newPort.getElementsByTagName('*');
                for (i = 0; i < children.length; i++) {
                    var newChild = children[i];
                    // If this is an address element (an kind soap, wsdl, etc) then replace the location
                    if (newChild.localName == ADDRESS) {
                        if (newChild.hasAttribute(LOCATION)) {
                            newChild.setAttribute(LOCATION, serviceEndpoint);
                        }
                    }
                } // for children
            } // for endpoints
        }
    }
    return isModified;
}

exports.setServiceEndpoint = setServiceEndpoint;
exports.injectServiceEndpointsIntoWSDLorZIP = injectServiceEndpointsIntoWSDLorZIP;
