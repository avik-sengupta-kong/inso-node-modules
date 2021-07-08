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
* Functions that generate the SOAP related constructs into the swagger document
**/

const u = require('../lib/utils.js');
var _ = require('lodash');
const dictionary = require('../lib/dictionary.js');
const genDefs = require('../lib/generateDefs.js');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');

/**
* Process the WSDL and generate the SOAP sections of the api.
* @param serviceName name of the wsdl service for this apic
* @param wsdlId the wsdl id
* @param wsdlJson the object model from the node soap package
* @param wsdlDefNamespaces the prefix->namespace definitions from the wsdl definition
* @param globalNamespaces the global namespace map defining unique prefixes for each namespace
* @param serviceJSON from merged wsdlJson
* @param dict is the Dictionary
* @param refMap is the referenced definition map
* @param options create options
* @return swagger with information from the soap sections of the wsdl
*/
function generateSOAP(serviceName, wsdlId, wsdlJson, wsdlDefNamespaces, globalNamespaces, serviceJSON, dict, refMap, options) {
    let tns = dict.wsdlTNS;
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

    // Create the initial swagger
    let swagger = initializeSwagger(serviceName, title, wsdlId, options.type);
    if (!options.wssecurity) {
        delete swagger.definitions.Security;
    }

    // Create a bindings to binding operations map
    let bindings = {};
    let defBindings = u.makeSureItsAnArray(wsdlJson.definitions.binding);
    for (let j = 0; j < defBindings.length; j++) {
        let binding = defBindings[j];
        let bindingType = binding['undefined'].type;
        bindingType = u.stripNamespace(bindingType);
        let usingAddressing = !!binding.UsingAddressing;
        let operations = u.makeSureItsAnArray(binding.operation);
        let ops = [];
        for (let i = 0; i < operations.length; i++) {
            let operation = operations[i];
            ops.push({
                name: operation['undefined'].name,
                operation: operation,
                usingAddressing: usingAddressing
            });
        }
        bindings[binding['undefined'].name] = {
            binding: binding,
            type: bindingType,
            operations: ops
        };
    }

    // Create portType to operations map
    let portTypes = {};
    let defPortTypes = u.makeSureItsAnArray(wsdlJson.definitions.portType);
    for (let j = 0; j < defPortTypes.length; j++) {
        let portType = defPortTypes[j];
        let operations = u.makeSureItsAnArray(portType.operation);
        let ops = [];
        for (let i = 0; i < operations.length; i++) {
            let operation = operations[i];
            ops.push({
                name: operation['undefined'].name,
                operation: operation
            });
        }
        portTypes[portType['undefined'].name] = {
            portType: portType,
            operations: ops
        };
    }

    // Create a message name to message map
    let messages = {};
    let defMessages = u.makeSureItsAnArray(wsdlJson.definitions.message);
    for (let j = 0; j < defMessages.length; j++) {
        let message = defMessages[j];
        let localNamespaces = getNamespaces(message, wsdlDefNamespaces);
        message.xmlns = localNamespaces;
        let msgNsName = dictionary.resolveNameInNamespace(message['undefined'].name, 'wsdl', localNamespaces, globalNamespaces, message.tns ? message.tns : tns);
        messages[msgNsName] = message;

        // Syntax check of the message
        let parts = u.makeSureItsAnArray(message.part);
        for (let z = 0; z < parts.length; z++) {
            if (parts[z]['undefined'].type && parts[z]['undefined'].element) {
                R.error(req,
                  g.http(u.r(req)).f('Message %s has a part with both type and element attributes. This is a violation of a WS-I Rule (R2306 A wsdl:message in a DESCRIPTION MUST NOT specify both type and element attributes on the same wsdl:part). ' +
                  'Processing continues without the type attribute.',
                  msgNsName));
                delete parts[z]['undefined'].type;
            }
        }
    }

    // Walk the services and generate operations, paths, etc.
    let defServices = u.makeSureItsAnArray(wsdlJson.definitions.service);
    for (let k = 0; k < defServices.length; k++) {
        let service = defServices[k];
        if (service['undefined'].name == serviceName) {
            if (service.documentation) {
                swagger.info.description = u.cleanupDocumentation(service.documentation, req);
            }

            // Create a map of binding name -> port name array
            let bindingLookup = {};
            let considerPorts = u.makeSureItsAnArray(service.port);

            // If a port was specified, then use that port.
            if (options.port) {
                let foundPort;
                for (let p = 0; p < considerPorts.length; p++) {
                    let tryPort = considerPorts[p];
                    if (tryPort && tryPort['undefined'] && (tryPort['undefined'].name === options.port)) {
                        foundPort = tryPort;
                        break;
                    }
                }
                if (!foundPort) {
                    throw g.http(u.r(req)).Error(
                        'The SOAP port %s could not be found in the wsdl:service %s. The API cannot be generated.',
                        options.port,
                        serviceName);
                }
                considerPorts = [ foundPort ];
            }

            // Now remove the non-soap ports
            let ports = [];
            for (let l = 0; l < considerPorts.length; l++) {
                let port = considerPorts[l];
                let bindingName = u.stripNamespace(port['undefined'].binding);
                if (bindings[bindingName] && bindings[bindingName].binding &&
                    bindings[bindingName].binding.binding && bindings[bindingName].binding.binding['undefined']) {
                    let b = bindings[bindingName].binding.binding['undefined'];
                    let isSOAP = (b &&
                       (b.transport ||
                        b.style == 'document' ||
                        b.style == 'rpc'));
                    if (isSOAP) {
                        ports = ports.concat(port);
                        if (!bindingLookup[bindingName]) {
                            bindingLookup[bindingName] = [];
                        }
                        bindingLookup[bindingName].push(port['undefined'].name);
                    }
                }
            }

            // The API is for a single port, generate the port information
            let portName = generatePort(swagger, serviceName, ports, globalNamespaces, serviceJSON, dict);
            let portValue = '{' + tns + '}' + portName;
            let isSoap12 = isSoap12Port(portName, serviceName, globalNamespaces, serviceJSON);

            // Get the binding operations and the portType for this portName
            let bindingOperations = [];
            let portTypeName = null;
            let isDocumentStyle = true;
            for (let bindingName in bindingLookup) {
                let pNames = bindingLookup[bindingName];
                let matchesPortName = false;
                for (let y = 0; y < pNames.length; y++) {
                    let pName = pNames[y];
                    if (pName == portName) {
                        matchesPortName = true;
                        break;
                    }
                }
                if (matchesPortName) {
                    let b = bindings[bindingName];
                    if (b) {
                        portTypeName = b.type;
                        if (bindings[bindingName]) {
                            // propogate xmlns and tns to bindingOperations
                            for (let i = 0; i < bindings[bindingName].operations.length; i++) {
                                if (bindings[bindingName].xmlns) {
                                    bindings[bindingName].operations[i].xmlns = bindings[bindingName].xmlns;
                                }
                                if (bindings[bindingName].tns) {
                                    bindings[bindingName].operations[i].tns = bindings[bindingName].tns;
                                }
                            }
                        }
                        bindingOperations = bindingOperations.concat(bindings[bindingName].operations);
                        // look out for the binding defining the style
                        if (b.binding.binding && b.binding.binding['undefined']) {
                            let style = b.binding.binding['undefined'].style;
                            if (style && style == 'rpc') {
                                isDocumentStyle = false;
                            }
                        }
                        break;
                    } else {
                        wsdlConstructNotFound(bindingName, 'binding', req, dict);
                    }
                }
            }

            // Now get the portType operations
            if (portTypeName == null || !portTypes[portTypeName]) {
                wsdlConstructNotFound(portTypeName, 'portType', req, dict);
                continue;
            }
            let portTypeOperations = portTypes[portTypeName].operations;
            let portType = portTypes[portTypeName].portType;
            let ptNamespaces = getNamespaces(portType, wsdlDefNamespaces);

            let usedMessages = {};
            let msgNameLookup = {};
            let msgNameOperLookup = {};
            if (portTypeOperations.length != bindingOperations.length) {
                throw g.http(u.r(req)).Error(
                  'This is a violation of a WS-I Rule (R2718 A wsdl:binding in a DESCRIPTION MUST have the same set of wsdl:operations as the wsdl:portType to which it refers).'
                );
            }
            for (let m = 0; m < portTypeOperations.length; m++) {
                let op = portTypeOperations[m];
                let bindingOper = getMatchingBindingOperation(op.operation['undefined'].name, bindingOperations);
                let boXMLNS = getNamespaces(bindingOper, wsdlDefNamespaces);
                let boTNS = bindingOper.tns || tns;
                if (bindingOper === null) {
                    throw g.http(u.r(req)).Error('Operation %s is not found. ',
                    'This is a violation of a WS-I Rule (R2718 A wsdl:binding in a DESCRIPTION MUST have the same set of wsdl:operations as the wsdl:portType to which it refers).',
                    op.operation['undefined'].name);
                }
                let soapAction = null;
                if (bindingOper.operation.operation && bindingOper.operation.operation['undefined']) {
                    soapAction = bindingOper.operation.operation['undefined'].soapAction;
                    let bindingOpStyle = bindingOper.operation.operation['undefined'].style;
                    if (bindingOpStyle && bindingOpStyle == 'rpc') {
                        // binding operation is defining the style
                        isDocumentStyle = false;
                    }
                }
                soapAction = soapAction || '';

                // Get the input, output, fault body of the binding operation
                let inputBody = getBody(bindingOper.operation.input);
                let outputBody = getBody(bindingOper.operation.output);
                let faultBody = getBody(bindingOper.operation.fault);

                // Get the part list for the input, output, fault of the binding operation
                let inputPartList = getParts(inputBody);
                let outputPartList = getParts(outputBody);
                let faultPartList = getParts(faultBody);

                // encoding is not support
                if ((inputBody && inputBody['undefined'].use === 'encoded') ||
                  (outputBody && outputBody['undefined'].use === 'encoded') ||
                  (faultBody && faultBody['undefined'].use === 'encoded')) {
                    R.error(req,
                       g.http(u.r(req)).f('The \'use=encoded\' attribute setting is ignored on wsdl \'operation\' %s. This is a violation of a WS-I Rule (R2706 A wsdl:binding in a DESCRIPTION MUST use the value of "literal" for the use attribute in all wsoap11:body, wsoap11:fault, wsoap11:header and wsoap11:headerfault elements).', op.operation['undefined'].name));
                }

                let inputMessage = null;
                let inputMessageName = null;
                let ptTNS = portType && portType.tns ? portType.tns : tns;
                if (op.operation.input) {
                    inputMessage = op.operation.input['undefined'].message;
                    // must resolve the namespace here as this will normalise use of duplicate namespaces and prefixes
                    inputMessage = dictionary.resolveNameInNamespace(inputMessage, 'wsdl', ptNamespaces, globalNamespaces, ptTNS);
                    if (!usedMessages[inputMessage]) {
                        if (inputPartList) {
                            usedMessages[inputMessage] = { parts: inputPartList, name: op.operation.input['undefined'].message, portValues: [], operations: []  };
                        } else {
                            usedMessages[inputMessage] = { parts: true, name: inputMessage, portValues: [], operations: [] };
                        }
                    }
                    if (usedMessages[inputMessage].portValues.indexOf(portValue) < 0) {
                        usedMessages[inputMessage].portValues.push(portValue);
                    }
                    if (usedMessages[inputMessage].operations.indexOf(op.operation['undefined'].name) < 0) {
                        usedMessages[inputMessage].operations.push(op.operation['undefined'].name);
                    }
                    let inputMsg = {
                        type: inputMessage
                    };
                    inputMsg.name = op.operation.input['undefined'].name ||
                        u.stripNamespace(op.operation.input['undefined'].message);

                    inputMessageName = [ inputMsg ];
                    if (isDocumentStyle) {
                        // message type comes from the message part type in document style
                        let inputContentParts = getMimeContentParts(op.operation['undefined'].name, bindingOper.operation.input, dict);
                        let opMessageInput = getMessagePartType(inputMessage, messages, inputPartList, globalNamespaces, inputContentParts, dict, tns, false);
                        if (opMessageInput && opMessageInput.length > 0) {
                            inputMessageName = opMessageInput;
                        }
                        // use raw element name from message for top-level body element name
                        msgNameOperLookup[inputMessage] = inputMessageName[0].elemName ? inputMessageName[0].elemName : op.name;
                    } else {
                        msgNameOperLookup[inputMessage] = op.name;
                        inputMsg.name = op.name;
                    }
                    msgNameLookup[inputMessage] = inputMessageName.length === 1 ? inputMessageName[0].type : inputMessage;
                }

                let outputMessage = null;
                let outputMessageName = null;
                if (op.operation.output) {
                    outputMessage = op.operation.output['undefined'].message;
                    // must resolve the namespace here as this will normalise use of duplicate namespaces and prefixes
                    outputMessage = dictionary.resolveNameInNamespace(outputMessage, 'wsdl', ptNamespaces, globalNamespaces, ptTNS);
                    if (!usedMessages[outputMessage]) {
                        if (outputPartList) {
                            usedMessages[outputMessage] = { parts: outputPartList, name: op.operation.output['undefined'].message, portValues: [], operations: []  };
                        } else {
                            usedMessages[outputMessage] = { parts: true, name: outputMessage, portValues: [], operations: [] };
                        }
                    }
                    if (usedMessages[outputMessage].portValues.indexOf(portValue) < 0) {
                        usedMessages[outputMessage].portValues.push(portValue);
                    }
                    if (usedMessages[outputMessage].operations.indexOf(op.operation['undefined'].name) < 0) {
                        usedMessages[outputMessage].operations.push(op.operation['undefined'].name);
                    }
                    var outputMsg = {
                        type: outputMessage
                    };
                    outputMsg.name = op.operation.output['undefined'].name ||
                        u.stripNamespace(op.operation.output['undefined'].message);

                    outputMessageName = [ outputMsg ];
                    if (isDocumentStyle) {
                        // message type comes from the message part type in document style
                        let outputContentParts = getMimeContentParts(op.operation['undefined'].name, bindingOper.operation.output, dict);
                        let opMessageOutput = getMessagePartType(outputMessage, messages, outputPartList, globalNamespaces, outputContentParts, dict, tns, false);
                        if (opMessageOutput && opMessageOutput.length > 0) {
                            outputMessageName = opMessageOutput;
                        }
                        // we must have correct undecorated name for response examples - use operation
                        // name lookup table for this as well - use raw element name
                        msgNameOperLookup[outputMessage] = outputMessageName[0].elemName ? outputMessageName[0].elemName : outputMsg.name;
                    } else {
                        msgNameOperLookup[outputMessage] = outputMsg.name;
                    }
                    msgNameLookup[outputMessage] = outputMessageName.length === 1 ? outputMessageName[0].type : outputMessage;
                }

                let faultMessages = [];
                if (op.operation.fault) {
                    let faults = u.makeSureItsAnArray(op.operation.fault);
                    let faultLen = faults.length;
                    for (let n = 0; n < faultLen; n++) {
                        let fault = faults[n];
                        let faultMessage = fault['undefined'].message;
                        // must resolve the namespace here as this will normalise use of duplicate namespaces and prefixes
                        faultMessage = dictionary.resolveNameInNamespace(faultMessage, 'wsdl', ptNamespaces, globalNamespaces, ptTNS);
                        if (!usedMessages[faultMessage]) {
                            usedMessages[faultMessage] = { parts: true, name: fault['undefined'].message, portValues: [], operations: [] };
                        }
                        if (usedMessages[faultMessage].portValues.indexOf(portValue) < 0) {
                            usedMessages[faultMessage].portValues.push(portValue);
                        }
                        if (usedMessages[faultMessage].operations.indexOf(op.operation['undefined'].name) < 0) {
                            usedMessages[faultMessage].operations.push(op.operation['undefined'].name);
                        }
                        let faultMessageName = u.stripNamespace(faultMessage);
                        if (fault['undefined'].name) {
                            faultMessageName = fault['undefined'].name;
                        }
                        let faultMessageEntry = {
                            message: faultMessage,
                            name: faultMessageName
                        };
                        if (isDocumentStyle) {
                            let faultContentParts = getMimeContentParts(op.operation['undefined'].name, bindingOper.operation.fault, dict);
                            let opMessageFault = getMessagePartType(faultMessage, messages, faultPartList, globalNamespaces, faultContentParts, dict, tns, true);
                            if (opMessageFault && opMessageFault.length > 0) {
                                msgNameOperLookup[faultMessage] = opMessageFault[0].elemName ? opMessageFault[0].elemName : faultMessageName;
                            } else {
                                msgNameOperLookup[faultMessage] = faultMessageName;
                            }
                        } else {
                            msgNameOperLookup[faultMessage] = faultMessageName;
                        }
                        faultMessages.push(faultMessageEntry);
                    } // end for
                }
                let operName = inputMessage ? msgNameOperLookup[inputMessage] : op.name;
                let operNamespace = inputBody && !isDocumentStyle ? inputBody['undefined'].namespace : null;
                if (!isDocumentStyle && !operNamespace) {
                    R.warning(req,
                      g.http(u.r(req)).f('Operation %s does not have a namespace. This is a violation of a WS-I Rule (R2717 An rpc-literal binding in a DESCRIPTION MUST have the namespace attribute specified, the value of which MUST be an absolute URI, on contained wsoap11:body elements). ' +
                      'Processing continues but problems may occur.',
                      operName));
                }
                let opDescription = op.operation.documentation ? u.cleanupDocumentation(op.operation.documentation, req) : '';

                // Each input, output and fault has a definition.  Create a unique NSName for the dictionary
                const inputNSName = dictionary.makeUniqueNSName(op.name + 'Input', dict);
                const outputNSName = dictionary.makeUniqueNSName(op.name + 'Output', dict);
                const headerInNSName = dictionary.makeUniqueNSName(op.name + 'Header', dict);
                const headerOutNSName = dictionary.makeUniqueNSName(op.name + 'HeaderOut', dict);
                const faultNSName = dictionary.makeUniqueNSName(op.name + 'Fault', dict);
                const headerFaultNSName = dictionary.makeUniqueNSName(op.name + 'HeaderFault', dict);

                // Generate the path post information for this operatin
                let path = {
                    post: {
                        summary: 'Operation ' + op.name,
                        description: opDescription,
                        operationId: op.name,
                        'x-ibm-soap': {
                            'soap-action': soapAction
                        }
                    }
                };
                if (inputMessage) {
                    path.post.parameters = [ {
                        in: 'body',
                        name: 'body',
                        required: true,
                        schema: {
                            $ref: '#/definitions/' + inputNSName
                        }
                    } ];
                }

                // Note that output responses is required by swagger.
                if (outputMessage) {
                    path.post.responses = {
                        default: {
                            description: '',
                            schema: {
                                $ref: '#/definitions/' + outputNSName
                            }
                        }
                    };
                } else {
                    // One way message, which is unusual.
                    // Due to customer complaints, add a respnse message with an empty schema.
                    path.post.responses = {
                        default: {
                            description: '',
                            schema: { }
                        }
                    };
                }
                swagger.paths['/' + op.name] = path;

                // Store path information in the Dictionary, so that we can update it later
                dict.pathInfo.push({
                    pathsKey: '/' + op.name,
                    operationName: operName,
                    operationNS: operNamespace,
                    inputMessages: inputMessageName
                });

                // Create the swagger definiton for the operation input
                var inputDefinition = getEnvelopeBodyTemplate(isSoap12, {
                    $ref: '#/definitions/' + headerInNSName
                });
                inputDefinition.example = '';
                inputDefinition.description = 'Input message for wsdl operation ' + operName;
                inputDefinition['x-ibm-schema'] = {
                    'wsdl-port': portValue,
                    'wsdl-operation': operName,
                    'wsdl-message-direction-or-name': operName + 'Request'
                    // Alternative
                    // 'wsdl-message-direction-or-name': op.operation.input && op.operation.input['undefined'] && op.operation.input['undefined'].name ?
                    //    op.operation.input['undefined'].name : operName + 'Request'
                };
                if (inputMessage) {
                    let inMsgLen = inputMessageName.length;
                    let inMsgPropName = '';
                    let inMsgName = null;
                    for (let aa = 0; aa < inMsgLen; aa++) {
                        inMsgName = inputMessageName[aa];
                        inMsgPropName = inMsgName.elemName ? inMsgName.elemName : inMsgName.name;
                        inputDefinition.properties.Envelope.properties.Body.properties[inMsgPropName] = {
                            $ref: '#/definitions/' + inMsgName.type
                        };
                        genDefs.addReference(refMap, inMsgName.type, {});
                    } // end for

                    // The root element in the body is required. (Aside: WSDL says it is required via part reference and
                    // the calling application will use the root element for operation resolution).
                    // If there is one root element in this message, mark it as required.
                    // If there are multiple ones, then this is an uncommon pattern
                    // so don't add required.
                    // (Aside: I am hesitant about marking the root element in the output as required since
                    // many SOAP stacks have more lenient validation of output (response) root elements).
                    if (inMsgLen == 1) {
                        inMsgName = inputMessageName[0];
                        inMsgPropName = inMsgName.elemName ? inMsgName.elemName : inMsgName.name;
                        if (!inputDefinition.properties.Envelope.properties.Body.required) {
                            inputDefinition.properties.Envelope.properties.Body.required = [];
                        }
                        inputDefinition.properties.Envelope.properties.Body.required.push(inMsgPropName);
                    }

                    if (!options.suppressExamples) {
                        inputDefinition.example = true;
                    }
                    swagger.definitions[inputNSName] = inputDefinition;

                    // A definition is created for the input header.
                    var inputHeaderDefinition = {
                        type: 'object',
                        properties: {
                            Security: {
                                $ref: '#/definitions/Security'
                            }
                        },
                        description: 'Input headers for wsdl operation ' + operName
                    };
                    if (!options.wssecurity) {
                        delete inputHeaderDefinition.properties.Security;
                    }
                    swagger.definitions[headerInNSName] = inputHeaderDefinition;

                    // Add WSA Headers if WSA is detected in the WSDL
                    if (bindingOper.usingAddressing) {
                        inputHeaderDefinition.properties.Action = {
                            $ref: '#/definitions/Action__WSA'
                        };
                        genDefs.addReference(refMap, 'Action__WSA', {});
                        inputHeaderDefinition.properties.To = {
                            $ref: '#/definitions/To__WSA'
                        };
                        genDefs.addReference(refMap, 'To__WSA', {});
                        inputHeaderDefinition.properties.ReplyTo = {
                            $ref: '#/definitions/ReplyTo__WSA'
                        };
                        genDefs.addReference(refMap, 'ReplyTo__WSA', {});
                        inputHeaderDefinition.properties.FaultTo = {
                            $ref: '#/definitions/FaultTo__WSA'
                        };
                        genDefs.addReference(refMap, 'FaultTo__WSA', {});
                        inputHeaderDefinition.properties.MessageID = {
                            $ref: '#/definitions/MessageID__WSA'
                        };
                        genDefs.addReference(refMap, 'MessageID__WSA', {});
                    }

                    // Now add the customer defined input headers
                    let inputHeaders = getHeaders(bindingOper.operation.input);
                    if (inputHeaders) {
                        let headers = u.makeSureItsAnArray(inputHeaders);
                        for (let x = 0; x < headers.length; x++) {
                            let header = headers[x];
                            if (header['undefined'].use === 'encoded') {
                                R.error(req,
                                  g.http(u.r(req)).f('The \'use=encoded\' attribute setting is ignored on wsdl \'operation\' %s. This is a violation of a WS-I Rule (R2706 A wsdl:binding in a DESCRIPTION MUST use the value of "literal" for the use attribute in all wsoap11:body, wsoap11:fault, wsoap11:header and wsoap11:headerfault elements).', op.operation['undefined'].name));
                            }
                            let headerMessageName = dictionary.resolveNameInNamespace(header['undefined'].message, 'wsdl', boXMLNS, globalNamespaces, boTNS);
                            let headerPart = header['undefined'].part;
                            wsiBindingHeaderCheck(header, op.operation['undefined'].name, dict, req);
                            let headerMessage = messages[headerMessageName];
                            if (headerMessage) {
                                let headerParts = u.makeSureItsAnArray(headerMessage.part);
                                for (let z = 0; z < headerParts.length; z++) {
                                    let hdrPart = headerParts[z];
                                    let hdrPartName = hdrPart['undefined'].name;
                                    if (hdrPartName == headerPart) {
                                        // found a part match, now add to header definition
                                        let hdrElemName = u.stripNamespace(hdrPart['undefined'].element);
                                        if (hdrElemName) {
                                            let hdrElemNsName = dictionary.bestMatch(hdrPart['undefined'].element, 'element', headerMessage, dict, globalNamespaces);
                                            inputHeaderDefinition.properties[hdrElemName] = {
                                                $ref: '#/definitions/' + hdrElemNsName
                                            };
                                            genDefs.addReference(refMap, hdrElemNsName, {});
                                            break;
                                        } else {
                                            R.error(req,
                                              g.http(u.r(req)).f('Part %s does not have an element attribute. This is a violation of a WS-I Rule(R2205 A wsdl:binding in a DESCRIPTION MUST refer, in each of its wsoap11:header, wsoap11:headerfault and wsoap11:fault elements, only to wsdl:part element(s) that have been defined using the element attribute). Processing continues without this part.',
                                              hdrPartName));
                                        }
                                    }
                                }
                            } else {
                                wsdlConstructNotFound(headerMessageName, 'message', req, dict);
                            }
                        }
                    }
                }

                // Now create the definition for the operation output
                let outputDefinition = getEnvelopeBodyTemplate(isSoap12, {});
                outputDefinition.description = 'Output message for wsdl operation ' + operName;
                outputDefinition['x-ibm-schema'] = {
                    'wsdl-port': portValue,
                    'wsdl-operation': operName,
                    'wsdl-message-direction-or-name': operName + 'Response'
                    // Alternative:
                    // 'wsdl-message-direction-or-name': op.operation.output && op.operation.output['undefined'] && op.operation.output['undefined'].name ?
                    //    op.operation.output['undefined'].name : operName + 'Response'
                };
                if (outputMessage) {
                    let outMsgPropName = '';
                    for (let ab = 0; ab < outputMessageName.length; ab++) {
                        let outMsgName = outputMessageName[ab];
                        outMsgPropName = outMsgName.elemName ? outMsgName.elemName : outMsgName.name;
                        outputDefinition.properties.Envelope.properties.Body.properties[outMsgPropName] = {
                            $ref: '#/definitions/' + outMsgName.type
                        };
                        genDefs.addReference(refMap, outMsgName.type, {});
                    }
                    if (!options.suppressExamples) {
                        outputDefinition.example = true;
                    }
                    swagger.definitions[outputNSName] = outputDefinition;
                    // Create the output header definition
                    let outputHeaderDefinition = {
                        type: 'object',
                        properties: {},
                        description: 'Output headers for wsdl operation ' + operName
                    };
                    // Now add the customer defined output headers
                    let outputHeaders = getHeaders(bindingOper.operation.output);
                    if (!outputHeaders) {
                        // If not output header, delete the placeholder
                        delete outputDefinition.properties.Envelope.properties.Header;
                    } else {
                        swagger.definitions[headerOutNSName] = outputHeaderDefinition;
                        outputDefinition.properties.Envelope.properties.Header = {
                            $ref: '#/definitions/' + headerOutNSName
                        };
                        let headersOut = u.makeSureItsAnArray(outputHeaders);
                        for (let x = 0; x < headersOut.length; x++) {
                            let headerOut = headersOut[x];
                            if (headerOut['undefined'] && headerOut['undefined'].use === 'encoded') {
                                R.error(req,
                                  g.http(u.r(req)).f('The \'use=encoded\' attribute setting is ignored on wsdl \'operation\' %s. This is a violation of a WS-I Rule (R2706 A wsdl:binding in a DESCRIPTION MUST use the value of "literal" for the use attribute in all wsoap11:body, wsoap11:fault, wsoap11:header and wsoap11:headerfault elements).', op.operation['undefined'].name));
                            }
                            let headerOutMessageName = dictionary.resolveNameInNamespace(headerOut['undefined'].message, 'wsdl', boXMLNS, globalNamespaces, boTNS);
                            let headerOutPart = headerOut['undefined'].part;
                            let headerOutMessage = messages[headerOutMessageName];
                            if (headerOutMessage) {
                                let headerOutParts = u.makeSureItsAnArray(headerOutMessage.part);
                                for (let z = 0; z < headerOutParts.length; z++) {
                                    let hdrOutPart = headerOutParts[z];
                                    let hdrOutPartName = hdrOutPart['undefined'].name;
                                    if (hdrOutPartName == headerOutPart) {
                                        // found a part match, now add to header definition
                                        let hdrOutElemName = u.stripNamespace(hdrOutPart['undefined'].element);
                                        if (hdrOutElemName) {
                                            let hdrOutElemNsName = dictionary.bestMatch(hdrOutPart['undefined'].element, 'element', headerOutMessage, dict, globalNamespaces);
                                            outputHeaderDefinition.properties[hdrOutElemName] = {
                                                $ref: '#/definitions/' + hdrOutElemNsName
                                            };
                                            genDefs.addReference(refMap, hdrOutElemNsName, {});
                                            break;
                                        } else {
                                            R.error(req,
                                              g.http(u.r(req)).f('Part %s does not have an element attribute. This is a violation of a WS-I Rule(R2205 A wsdl:binding in a DESCRIPTION MUST refer, in each of its wsoap11:header, wsoap11:headerfault and wsoap11:fault elements, only to wsdl:part element(s) that have been defined using the element attribute). Processing continues without this part.',
                                              hdrOutPartName));

                                        }
                                    }
                                }
                            } else {
                                wsdlConstructNotFound(headerOutMessageName, 'message', req, dict);
                            }
                        }
                    }
                }

                // Now add the operation fault definition
                if (faultMessages.length > 0  ||
                    options.type === 'wsdl-to-rest' && options.mapSOAPFaults) {
                    var faultDefinition = getEnvelopeBodyFaultTemplate(isSoap12, {});
                    faultDefinition.description = 'Fault message for wsdl operation ' + operName;
                    let faults = u.makeSureItsAnArray(op.operation.fault);
                    faultDefinition['x-ibm-schema'] = {
                        'wsdl-port': portValue,
                        'wsdl-operation': operName,
                        'wsdl-message-direction-or-name': faults && faults.length === 1 && faults[0]['undefined'] && faults[0]['undefined'].name ?
                            faults[0]['undefined'].name : operName + 'Fault'
                    };

                    // add a 500 response
                    if (!path.post.responses) {
                        path.post.responses = {};
                    }
                    path.post.responses['500'] = {
                        description: '',
                        schema: {
                            $ref: '#/definitions/' + faultNSName
                        }
                    };

                    let faultHeaderDefinition = {
                        type: 'object',
                        properties: {},
                        description: 'Fault header for wsdl operation ' + operName
                    };
                    let fHeaders = getHeaders(bindingOper.operation.fault);
                    if (fHeaders) {
                        swagger.definitions[headerFaultNSName] = faultHeaderDefinition;
                        let headers = u.makeSureItsAnArray(fHeaders);
                        for (let x = 0; x < headers.length; x++) {
                            let header = headers[x];
                            if (header['undefined'].use === 'encoded') {
                                R.error(req,
                                  g.http(u.r(req)).f('The \'use=encoded\' attribute setting is ignored on wsdl \'operation\' %s. This is a violation of a WS-I Rule (R2706 A wsdl:binding in a DESCRIPTION MUST use the value of "literal" for the use attribute in all wsoap11:body, wsoap11:fault, wsoap11:header and wsoap11:headerfault elements).', op.operation['undefined'].name));
                            }
                            let headerMessageName = dictionary.resolveNameInNamespace(header['undefined'].message, 'wsdl', boXMLNS, globalNamespaces, boTNS);
                            let headerPart = header['undefined'].part;
                            wsiBindingHeaderCheck(header, op.operation['undefined'].name, dict, req);
                            let headerMessage = messages[headerMessageName];
                            if (headerMessage) {
                                let headerParts = u.makeSureItsAnArray(headerMessage.part);
                                for (let z = 0; z < headerParts.length; z++) {
                                    let hdrPart = headerParts[z];
                                    let hdrPartName = hdrPart['undefined'].name;
                                    if (hdrPartName == headerPart) {
                                        // found a part match, now add to header definition
                                        let hdrElemName = u.stripNamespace(hdrPart['undefined'].element);
                                        if (hdrElemName) {
                                            let hdrElemNsName = dictionary.bestMatch(hdrPart['undefined'].element, 'element', headerMessage, dict, globalNamespaces);
                                            faultHeaderDefinition.properties[hdrElemName] = {
                                                $ref: '#/definitions/' + hdrElemNsName
                                            };
                                            genDefs.addReference(refMap, hdrElemNsName, {});
                                            break;
                                        } else {
                                            R.error(req,
                                              g.http(u.r(req)).f('Part %s does not have an element attribute. This is a violation of a WS-I Rule(R2205 A wsdl:binding in a DESCRIPTION MUST refer, in each of its wsoap11:header, wsoap11:headerfault and wsoap11:fault elements, only to wsdl:part element(s) that have been defined using the element attribute). Processing continues without this part.',
                                              hdrPartName));
                                        }
                                    }
                                }
                            } else {
                                wsdlConstructNotFound(headerMessageName, 'message', req, dict);
                            }
                        }
                    }

                    // Now add the fault header definition
                    let faultHeaders = getFaultHeaders(bindingOper.operation.input, bindingOper.operation.output, bindingOper.operation.fault);
                    if (!faultHeaders) {
                        // If not fault header, delete the placeholder
                        delete faultDefinition.properties.Envelope.properties.Header;
                    } else {
                        swagger.definitions[headerFaultNSName] = faultHeaderDefinition;
                        faultDefinition.properties.Envelope.properties.Header = {
                            $ref: '#/definitions/' + headerFaultNSName
                        };
                        genDefs.addReference(refMap, headerFaultNSName, {});
                        let headersFault = u.makeSureItsAnArray(faultHeaders);
                        for (let x = 0; x < headersFault.length; x++) {
                            let headerFault = headersFault[x];
                            if (headerFault['undefined'] && headerFault['undefined'].use === 'encoded') {
                                R.error(req,
                                  g.http(u.r(req)).f('The \'use=encoded\' attribute setting is ignored on wsdl \'operation\' %s. This is a violation of a WS-I Rule (R2706 A wsdl:binding in a DESCRIPTION MUST use the value of "literal" for the use attribute in all wsoap11:body, wsoap11:fault, wsoap11:header and wsoap11:headerfault elements).', op.operation['undefined'].name));
                            }
                            let headerFaultMessageName = dictionary.resolveNameInNamespace(headerFault['undefined'].message, 'wsdl', boXMLNS, globalNamespaces, boTNS);
                            let headerFaultPart = headerFault['undefined'].part;
                            wsiBindingHeaderCheck(headerFault, op.operation['undefined'].name, dict, req);
                            let headerFaultMessage = messages[headerFaultMessageName];
                            if (headerFaultMessage) {
                                let headerFaultParts = u.makeSureItsAnArray(headerFaultMessage.part);
                                let hpartFaultLen = headerFaultParts.length;
                                for (let z = 0; z < hpartFaultLen; z++) {
                                    let hdrFaultPart = headerFaultParts[z];
                                    let hdrFaultPartName = hdrFaultPart['undefined'].name;
                                    if (hdrFaultPartName == headerFaultPart) {
                                        // found a part match, now add to header definition
                                        let hdrFaultElemName = u.stripNamespace(hdrFaultPart['undefined'].element);
                                        if (hdrFaultElemName) {
                                            let hdrFaultElemNsName = dictionary.bestMatch(hdrFaultPart['undefined'].element, 'element', headerFaultMessage, dict, globalNamespaces);
                                            faultHeaderDefinition.properties[hdrFaultElemName] = {
                                                $ref: '#/definitions/' + hdrFaultElemNsName
                                            };
                                            genDefs.addReference(refMap, hdrFaultElemNsName, {});
                                            break;
                                        } else {
                                            R.error(req,
                                              g.http(u.r(req)).f('Part %s does not have an element attribute. This is a violation of a WS-I Rule(R2205 A wsdl:binding in a DESCRIPTION MUST refer, in each of its wsoap11:header, wsoap11:headerfault and wsoap11:fault elements, only to wsdl:part element(s) that have been defined using the element attribute). Processing continues without this part.',
                                              hdrFaultPartName));
                                        }
                                    }
                                } // end for
                            } else {
                                wsdlConstructNotFound(headerFaultMessageName, 'message', req, dict);
                            }
                        } // end for
                    }
                    // The fault details object is different for SOAP 1.1 v 1.2
                    // Add a fault message references into the fault details
                    let detailProps;
                    if (isSoap12) {
                        detailProps = faultDefinition.properties.Envelope.properties.Body.properties.Fault.properties.Detail.properties;
                        genDefs.addReference(refMap, 'SubCode__SOAP12', {});
                    } else {
                        detailProps = faultDefinition.properties.Envelope.properties.Body.properties.Fault.properties.detail.properties;
                    }
                    for (let p = 0; p < faultMessages.length; p++) {
                        let faultMsg = faultMessages[p];
                        detailProps[faultMsg.name] = {
                            $ref: '#/definitions/' + faultMsg.message
                        };
                    }

                    swagger.definitions[faultNSName] = faultDefinition;
                }

            } // end for

            // Create a definition for each used message
            for (let messageName in usedMessages) {
                let msgNSName = msgNameLookup[messageName] || messageName;

                let prefix = u.getPrefixForNamespace(tns, globalNamespaces);
                let msgDefinition = {
                    xml: {
                        namespace: tns,
                        prefix: prefix
                    },
                    type: 'object',
                    properties: {}
                };
                let partList = usedMessages[messageName].parts;
                if (partList === true) {
                    partList = null; // only interested in the array version
                }
                let msg = messages[messageName];
                if (!msg) {
                    wsdlConstructNotFound(messageName, 'message', req, dict);
                    continue;
                }
                let parts = u.makeSureItsAnArray(msg.part);
                for (let i = 0; i < parts.length; i++) {
                    let part = parts[i];
                    let partName = part['undefined'].name;
                    let partType = part['undefined'].type;
                    let kind = 'type';
                    if (!partType) {
                        partType = part['undefined'].element;
                        kind = 'element';
                    }
                    let partNSName = dictionary.bestMatch(partType, kind, msg, dict, globalNamespaces);
                    let dictEntry = dict.dictEntry[partNSName];
                    let partNameOK = false;
                    if (!partList) {
                        partNameOK = true; // empty part list means take all parts
                    } else if (partList.indexOf(partName) != -1) {
                        partNameOK = true;
                    }
                    if (partNameOK) {
                        let property = {};
                        if (dictEntry) {
                            // found a custom type
                            let referencingContext = dict.dictEntry[partNSName] && dict.dictEntry[partNSName].tagInfo ?
                                dict.dictEntry[partNSName].tagInfo.xml : null;

                            // Note that in rpc style, the part should always use type= not element=
                            // And in such cases the parser should emit the name of the part and unqualified namespace
                            // (The current behavior of the parser if rpc and element= is to emit the part name and the element namespace information.
                            // I am not sure at this point in the code that we can definitely determine if this emit is only for rpc.)
                            if (part['undefined'].type) {
                                referencingContext = {
                                    ns: genDefs.UNQUALNS
                                };
                            }
                            let xso = genDefs.generateSwaggerXSO(dictEntry, dict, refMap, globalNamespaces, referencingContext);
                            // The xso is for either a message or if doc/lit, the part element (which is a normal NSName).
                            // In the latter case, we want to turn off polymorphism for the element.
                            if (xso.typeOf) {
                                xso.forPart = true; // Special magic
                            }
                            u.extendObject(property, xso);
                        } else {
                            let xso = genDefs.mapXSDTypeToSwagger(u.stripNamespace(partType), dict);
                            u.extendObject(property, xso);
                        }
                        if (isDocumentStyle) {
                            if (Object.keys(msgDefinition.properties).length == 0) {
                                u.extendObject(msgDefinition, property);
                                // switch type to allOf
                                if (property.allOf || property.oneOf || property.anyOf) {
                                    delete msgDefinition.properties;
                                    delete msgDefinition.type;
                                }
                                if (msgDefinition.type && msgDefinition.type != 'object') {
                                    delete msgDefinition.properties;
                                }
                            } else {
                                u.extendObject(msgDefinition.properties, property.properties);
                            }
                        } else {
                            msgDefinition.properties[partName] = property;
                        }
                    }
                } // end for
                if (!options.suppressExamples) {
                    msgDefinition.example = true;
                }
                msgDefinition.xml.name = msgNameOperLookup[messageName] ?  msgNameOperLookup[messageName] : _.split(msgNSName)[0];
                swagger.definitions[msgNSName] = msgDefinition;
            } // end for
        }
    }
    return swagger;
}

/**
* @param stmt object from node soap package (message, porttype, binding, etc)
* @param parentNamespaces is the prefix -> namespace map of the defining context of the stmt
* @return namespace map of the stmt or the defining context
*/
function getNamespaces(stmt, parentNamespaces) {
    return stmt && stmt.xmlns && Object.keys(stmt.xmlns).length > 0 ? stmt.xmlns : u.deepClone(parentNamespaces);
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

function wsdlConstructNotFound(name, wsdlConstruct, req, dict) {
    let msg = g.http(u.r(req)).f('Could not find wsdl %s with the name %s. This is a violation of a WS-I Rule (R2101 A DESCRIPTION MUST NOT use QName references to WSDL components in namespaces that have been neither imported, nor defined in the referring WSDL document).', wsdlConstruct, name);
    R.error(req, msg);
}

/**
* WS-I Check
* @param h is a binding header or binding headerFault
**/
function wsiBindingHeaderCheck(h, operName, dict, req) {
    if (h['undefined'].part === null) {
        let msg = g.http(u.r(req)).f('A header or headerFault in binding operation %s is missing the part attribute. This is a violation of a WS-I Rule (R2720 A wsdl:binding in a DESCRIPTION MUST use the part attribute with a schema type of "NMTOKEN" on all contained wsoap11:header and wsoap11:headerfault elements).',
           operName);
        R.error(req, msg);
    }
    if (h['undefined'].parts) {
        let msg = g.http(u.r(req)).f('A header or headerFault in binding operation %s has a parts attribute. This is a violation of a WS-I Rule (R2749 A wsdl:binding in a DESCRIPTION MUST NOT use the parts attribute on contained wsoap11:header and wsoap11:headerfault elements).',
           operName);
        R.error(req, msg);
    }
}

/**
* Generate the initial swagger
*/
function initializeSwagger(serviceName, title, wsdlId, type) {
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
        basePath: '/' + serviceName,
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
            'wsdl-definition': {
                wsdl: wsdlId,
                service: serviceName,
                port: '',
                'soap-version': '1.1',
            },
            assembly: {
                execute: [ ]
            }
        },
        paths: {},
        definitions: {
            // Note that the each property has an xml object.  This is required for the example xml generation.
            Security: {
                xml: {
                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
                    prefix: 'wsse'
                },
                description: 'Header for WS-Security',
                type: 'object',
                properties: {
                    UsernameToken: {
                        xml: {
                            namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
                            prefix: 'wsse'
                        },
                        type: 'object',
                        properties: {
                            Username: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
                                    prefix: 'wsse'
                                },
                                type: 'string'
                            },
                            Password: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
                                    prefix: 'wsse'
                                },
                                type: 'string'
                            },
                            Nonce: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
                                    prefix: 'wsse'
                                },
                                type: 'string',
                                properties: {
                                    EncodingType: {
                                        xml: {
                                            namespace: '',
                                            attribute: true
                                        },
                                        type: 'string'
                                    }
                                }
                            },
                            Created: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
                                    prefix: 'wsu'
                                },
                                type: 'string'
                            }
                        }
                    },
                    Timestamp: {
                        xml: {
                            namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
                            prefix: 'wsu'
                        },
                        type: 'object',
                        properties: {
                            Created: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
                                    prefix: 'wsu'
                                },
                                type: 'string'
                            },
                            Expires: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
                                    prefix: 'wsu'
                                },
                                type: 'string'
                            },
                            Id: {
                                xml: {
                                    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
                                    prefix: 'wsu',
                                    attribute: true
                                },
                                type: 'string'
                            },
                        }
                    }
                }
            }
        }
    };
    swagger['x-ibm-configuration'].assembly.execute[0] = {
        proxy: {
            title: 'proxy',
            'target-url': ''
        }
    };
    return swagger;
}

/**
* Generate the swagger information for the soap port
*/
function generatePort(swagger, serviceName, ports, namespaces, serviceJSON, dict) {
    let req = dict.req;
    // use the first port to populate the swagger wsdl config info
    let portName = '';
    if (ports.length > 0) {
        let usedPort = ports[0];
        portName = usedPort['undefined'].name;
        let isSoap12 = isSoap12Port(portName, serviceName, namespaces, serviceJSON);
        if (isSoap12) {
            // switch swagger into SOAP 1.2 mode
            swagger['x-ibm-configuration']['wsdl-definition']['soap-version'] = '1.2';
            swagger.consumes = [ 'application/soap+xml' ];
        }
        swagger['x-ibm-configuration']['wsdl-definition'].port = portName;
        if (usedPort.address) {
            let portLoc = usedPort.address['undefined'].location;
            if (portLoc) {
                if (portLoc.indexOf('localhost') == -1) {
                    setTargetUrl(swagger, portLoc);
                }
            }
        }
        if (ports.length > 1) {
            let msg = g.http(u.r(req)).f('The wsdl \'service\' has multiple \'ports\'. The api is generated using information in the first soap \'port\'.');
            R.info(req, msg);
        }
    }
    return portName;
}

function setTargetUrl(swagger, url) {
    let execute = swagger['x-ibm-configuration'].assembly.execute;
    if (execute[0].proxy) {
        execute[0].proxy['target-url'] = url;
    } else if (execute[0].invoke) {
        execute[0].invoke['target-url'] = url;
    }
}


/*
* Determine if this is a SOAP11 or SOAP12 port
* Find the indicated port in the service and inspect the address tag.
* If the address tag is defined by the SOAP 1.2 specification, return true.
* @return true if SOAP12
*/
function isSoap12Port(portName, serviceName, namespaces, serviceJSON) {
    let prefixSOAP12 = getSoap12Prefix(namespaces);
    if (prefixSOAP12) {
        if (serviceJSON && serviceJSON.service) {
            serviceJSON.service = u.makeSureItsAnArray(serviceJSON.service);
            for (let i = 0; i < serviceJSON.service.length; i++) {
                let service = serviceJSON.service[i];
                // Get the service that matches the serviceName
                if (service && service['undefined'] && service['undefined'].name === serviceName) {
                    if (service.port) {
                        service.port = u.makeSureItsAnArray(service.port);
                        for (let j = 0; j < service.port.length; j++) {
                            let port = service.port[j];
                            // Get the port within the service that matches portName
                            if (port && port['undefined'] && port['undefined'].name === portName) {
                                if (port.address) {
                                    let address = _.isArray(port.address) ? port.address[0] : port.address;
                                    // Get the address tag and determine if its prefix is mapped to the SOAP 1.2
                                    if (address && address['undefined'] && address['undefined'].__name__) {
                                        let words = _.split(address['undefined'].__name__, ':');
                                        let prefix = words.length === 1 ? '' : words[0];
                                        if (prefix === prefixSOAP12) {
                                            return true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return false;
}

function getSoap12Prefix(namespaces) {
    var ret = '';
    for (var key in namespaces) {
        var namespace = namespaces[key];
        if (namespace == 'http://schemas.xmlsoap.org/wsdl/soap12/') {
            ret = key;
            break;
        }
    } // end for
    return ret;
}

/**
* Get the binding operation that matches name (the portType operation)
*/
function getMatchingBindingOperation(name, bindingOperations) {
    var ret = null;
    if (name && bindingOperations) {
        var len = bindingOperations.length;
        for (var i = 0; i < len; i++) {
            var op = bindingOperations[i];
            if (op.operation['undefined'].name == name) {
                ret = op;
                break;
            }
        }
    }
    return ret;
}

/**
* Utility to get the body object from an wsdl input, output or fault.
* Normally it is a first level object, but in rare cases it could be
* nexted in a multipartRelated.part
*/
function getBody(inoutfault) {
    if (!inoutfault) {
        return null;
    } else if (inoutfault.body) {
        return inoutfault.body;
    } else if (inoutfault.multipartRelated &&
               inoutfault.multipartRelated.part) {
        for (var p = 0; p < inoutfault.multipartRelated.part.length; p++) {
            var part = inoutfault.multipartRelated.part[p];
            if (part.body) {
                return part.body;
            }
        }
    }
    return null;
}

/**
* Return headers from input or output in binding operation
*/
function getHeaders(inout) {
    if (!inout) {
        return null;
    } else if (inout.header) {
        return inout.header;
    } else if (inout.multipartRelated &&
               inout.multipartRelated.part) {
        for (var p = 0; p < inout.multipartRelated.part.length; p++) {
            var part = inout.multipartRelated.part[p];
            if (part.header) {
                return part.header;
            }
        }
    }
    return null;
}

/*
* Get all of the header faults
*/
function getFaultHeaders(input, output, fault) {
    var faultHeaders = [];
    var inHeaders = getHeaders(input);
    var outHeaders = getHeaders(output);
    var fhs = getHeaders(fault);
    var i, j, hfaults;
    if (inHeaders) {
        inHeaders = u.makeSureItsAnArray(inHeaders);
        for (i = 0; i < inHeaders.length; i++) {
            if (inHeaders[i].headerfault) {
                hfaults = u.makeSureItsAnArray(inHeaders[i].headerfault);
                for (j = 0; j < hfaults.length; j++) {
                    faultHeaders.push(hfaults[j]);
                }
            }
        }
    }
    if (outHeaders) {
        outHeaders = u.makeSureItsAnArray(outHeaders);
        for (i = 0; i < outHeaders.length; i++) {
            if (outHeaders[i].headerfault) {
                hfaults = u.makeSureItsAnArray(outHeaders[i].headerfault);
                for (j = 0; j < hfaults.length; j++) {
                    faultHeaders.push(hfaults[j]);
                }
            }
        }
    }
    if (fhs) {
        fhs = u.makeSureItsAnArray(fhs);
        for (i = 0; i < fhs.length; i++) {
            if (fhs[i].headerfault) {
                hfaults = u.makeSureItsAnArray(fhs[i].headerfault);
                for (j = 0; j < hfaults.length; j++) {
                    faultHeaders.push(hfaults[j]);
                }
            }
        }
    }
    if (faultHeaders.length == 0) {
        return null;
    }
    return faultHeaders;
}


/**
** Get part names that are mime:content
* @param inoutfault is input output or fault object
*/
function getMimeContentParts(opName, inoutfault, dict) {
    let req = dict.req;
    var ret = [];
    if (inoutfault &&
        inoutfault.multipartRelated &&
        inoutfault.multipartRelated.part) {
        for (var p = 0; p < inoutfault.multipartRelated.part.length; p++) {
            var part = inoutfault.multipartRelated.part[p];
            if (part.content &&
                part.content['undefined'] &&
                part.content['undefined'].part) {
                ret.push(part.content['undefined'].part);
                R.info(req,
                  g.http(u.r(req)).f('Ignoring \'mime:content\' \'part\' %s.', part.content['undefined'].part));
            }
        }
    }
    return ret;
}

function getMessagePartType(messageNsName, messages, partList, namespaces, contentPartList, dict, tns, forFault) {
    let req = dict.req;
    contentPartList = contentPartList ? contentPartList : [];
    var ret = [];
    var opMsgParts;
    var opMessage = messages[messageNsName];
    if (opMessage) {
        opMsgParts = u.makeSureItsAnArray(opMessage.part);
    }
    if (partList && partList.length > 1) {
        R.error(req,
          g.http(u.r(req)).f('A parts attribute has more than one value %s even though the \'style\' is \'document\'. This is a violation of a WS-I Rule (R2201 A document-literal binding in a DESCRIPTION MUST, in each of its wsoap11:body element(s), have at most one part listed in the parts attribute, if the parts attribute is specified). This situation is tolerated but could cause problems.', partList));
    } else if (!partList && opMsgParts > 1) {
        R.error(req,
          g.http(u.r(req)).f('A parts attribute is missing and the corresponding message %s has more than one part. This is a violation of a WS-I Rule (R2210 If a document-literal binding in a DESCRIPTION does not specify the parts attribute on a wsoap11:body element, the corresponding abstract wsdl:message MUST define zero or one wsdl:parts). This situation is tolerated but could cause problems.', messageNsName));
    }
    if (opMessage) {
        var len = opMsgParts.length;
        for (var i = 0; i < len; i++) {
            var opMsgPart = opMsgParts[i];
            var opPartName = opMsgPart['undefined'].name;
            if (contentPartList.indexOf(opPartName) < 0) {
                var partNameOK = false;
                if (!partList) {
                    partNameOK = true; // take all parts on empty list
                } else if (partList.indexOf(opPartName) != -1) {
                    partNameOK = true;
                }
                if (partNameOK) {
                    // Scheu Note: This function is only called if
                    // style=document.  In such cases, I believe
                    // the parts must be elements (not type).
                    var opPartType = opMsgPart['undefined'].type;
                    if (opPartType) {
                        if (forFault) {
                            R.info(req,
                              g.http(u.r(req)).f('The wsdl \'part\' %s is defined with a \'type\' attribute even though the \'style\' is \'document\'. An \'element\' attribute was expected. This situation was found in the definition of a soap fault. This is a violation of a WS-I Rule (R2204 A document-literal binding in a DESCRIPTION MUST refer, in each of its wsoap11:body element(s), only to wsdl:part element(s) that have been defined using the element attribute).This situation is tolerated but could cause problems.', opPartName));
                        } else {
                            R.error(req,
                              g.http(u.r(req)).f('The wsdl \'part\' %s is defined with a \'type\' attribute even though the \'style\' is \'document\'. An \'element\' attribute was expected. This is a violation of a WS-I Rule (R2204 A document-literal binding in a DESCRIPTION MUST refer, in each of its wsoap11:body element(s), only to wsdl:part element(s) that have been defined using the element attribute).This situation is tolerated but could cause problems.', opPartName));
                        }
                    }
                    var elemName = '';
                    let kind = 'type';
                    if (!opPartType) {
                        opPartType = opMsgPart['undefined'].element;
                        elemName = u.stripNamespace(opMsgPart['undefined'].element);
                        kind = 'element';
                    }
                    opPartType = dictionary.bestMatch(opPartType, kind, opMessage, dict, namespaces);
                    ret.push({
                        name: opPartName,
                        elemName: elemName,
                        type: opPartType
                    });
                }
            }
        } // end for
    } else {
        wsdlConstructNotFound(messageNsName, 'message', req, dict);
    }
    if (partList && partList.length > 0 && partList.length !== ret.length) {
        R.warning(req,
          g.http(u.r(req)).f('Some of the parts (%s) were not found.  This situation is tolerated but could cause problems.', partList));
    }
    return ret;
}

function getParts(body) {
    if (body) {
        let rawInputPartList = body['undefined'].parts;
        if (rawInputPartList) {
            return rawInputPartList.split(' ');
        }
    }
    return null;
}

function getEnvelopeBodyTemplate(soap12, header) {
    var template = {
        type: 'object',
        properties: {
            Envelope: {
                xml: {
                    prefix: 'soapenv',
                    namespace: 'http://schemas.xmlsoap.org/soap/envelope/'
                },
                type: 'object',
                properties: {
                    Header: header,
                    Body: {
                        type: 'object',
                        properties: {}
                    }
                },
                required: [ 'Body' ]
            }
        },
        required: [ 'Envelope' ]
    };
    if (soap12) {
        template.properties.Envelope.xml.namespace = 'http://www.w3.org/2003/05/soap-envelope';
    }
    return template;
}

function getEnvelopeBodyFaultTemplate(soap12, header) {
    var template = getEnvelopeBodyTemplate(soap12, header);
    if (soap12) {
        template.properties.Envelope.properties.Body.properties.Fault = {
            type: 'object',
            properties: {
                Code: {
                    type: 'object',
                    properties: {
                        Value: {
                            type: 'string'
                        },
                        SubCode: {
                            $ref: '#/definitions/SubCode__SOAP12'
                        },
                    },
                    required: [ 'Value' ]
                },
                Reason: {
                    type: 'object',
                    properties: {
                        Text: {
                            type: 'array',
                            items: {
                                type: 'string'
                            }
                        }
                    }
                },
                Node: {
                    type: 'string'
                },
                Role: {
                    type: 'string'
                },
                Detail: {
                    type: 'object',
                    properties: {}
                }
            },
            required: [ 'Code', 'Reason' ]
        };
    } else {
        template.properties.Envelope.properties.Body.properties.Fault = {
            type: 'object',
            properties: {
                faultcode: {
                    xml: {
                        prefix: '',
                        namespace: ''
                    },
                    type: 'string'
                },
                faultstring: {
                    xml: {
                        prefix: '',
                        namespace: ''
                    },
                    type: 'string'
                },
                faultactor: {
                    xml: {
                        prefix: '',
                        namespace: ''
                    },
                    type: 'string'
                },
                detail: {
                    xml: {
                        prefix: '',
                        namespace: ''
                    },
                    type: 'object',
                    properties: {}
                }
            }
        };
    }
    return template;
}

/**
* Called after the definitions are generated.
* The paths are updated with the correct namespace information.
*/
function patchPaths(swagger, dict) {
    // patch up soap operation name for each path
    for (let i = 0; i < dict.pathInfo.length; i++) {
        let pathItem = dict.pathInfo[i];
        let pathOpName = pathItem.operationName;
        let pathOpNS = pathItem.operationNS;
        if (!pathOpNS) {
            let pathInputs = pathItem.inputMessages;
            if (pathInputs && pathInputs.length > 0) {
                let nsName = pathInputs[0].type;
                if (swagger.definitions[nsName] && swagger.definitions[nsName].xml) {
                    pathOpNS = swagger.definitions[nsName].xml.namespace;
                } else {
                    pathOpNS = dict.wsdlTNS;
                }
            } else {
                pathOpNS = dict.wsdlTNS;
            }
        }
        let soapOperation = '{' + pathOpNS + '}' + pathOpName;
        swagger.paths[pathItem.pathsKey].post['x-ibm-soap']['soap-operation'] = soapOperation;
    }
}

exports.generateSOAP = generateSOAP;
exports.patchPaths = patchPaths;
exports.getEnvelopeBodyFaultTemplate = getEnvelopeBodyFaultTemplate;
