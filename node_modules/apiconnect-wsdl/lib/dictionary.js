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
* Dictionary creation and access functions
**/
const u = require('../lib/utils.js');
var _ = require('lodash');

// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const R = require('../lib/report.js');

const SCHEMA_VERSIONING_NS = 'http://www.w3.org/2007/XMLSchema-versioning';


/*
* Walk the schemaList provided by node.soap and return a flat dictionary.
* The node.soap schema is accessed by dict.dictEntry[nsName] where nsName
* is <name>_<prefix>. The <name> is the name of the xml or soap construct and <prefix> is the
* prefix defined for the namespace which defines the construct.
*/
function buildDictionary(schemaList, detectedWSAddressing, namespaces, wsdlTNS, req) {
    let dictEntry = {};
    let schemaElements = {};
    let schemaAttributes = {};
    let substitutions = {};
    addPredefinedNSNames(dictEntry, detectedWSAddressing);
    schemaList = pruneSchemas(schemaList, req);

    let schemaImportMap = {};

    // Per the specification, the wsdl targetNamespace is not required, but in an actual scenario
    // it must be required.
    if (!wsdlTNS || wsdlTNS.length == 0) {
        R.error(req, g.http(u.r(req)).f(
          'The targetNamespace was not set on the wsdl definitions element. Processing continues assuming an empty targetNamespace. This is not a best practice and should be corrected.'));
    }
    let schemaLen = schemaList.length;
    // Temporarily remove the masked or secondary namespace declarations
    let namespacesValues = [];
    let masked = {};
    let prefixes = Object.keys(namespaces);
    for (let i = 0; i < prefixes.length; i++) {
        let prefix = prefixes[i];
        if (prefix === '__tns__') {
            // Don't consider for masked calculation
        } else {
            let ns = namespaces[prefix];
            if (namespacesValues.indexOf(ns) < 0) {
                namespacesValues.push(ns);
            } else {
                masked[prefix] = ns;
                delete namespaces[prefix];
            }
        }
    }
    // Examine the namespace definitions for each schema.
    // If prefix is found that is not in namespaces, and its namespace is unique, then add it to namespaces.
    for (let i = 0; i < schemaLen; i++) {
        // schema is the node.soap schema
        let schema = schemaList[i];
        let values = _.values(namespaces);
        if (schema.xmlns) {
            for (let prefix in schema.xmlns) {
                let ns = schema.xmlns[prefix];
                if (!namespaces[prefix] && values.indexOf(ns) < 0) {
                    namespaces[prefix] = ns;
                }
            }
        }
    }
    // Now add the masked namespaces back into namespaces
    for (let prefix in masked) {
        if (!namespaces[prefix]) {
            namespaces[prefix] = masked[prefix];
        }
    }
    for (let i = 0; i < schemaLen; i++) {
        // schema is the node.soap schema
        let schema = schemaList[i];
        // Get the target namespace and the qualification of elements and attributes
        let schemaTNS = '';
        let qualified = false;
        let qualifiedAttr = false;
        if (schema['undefined']) {
            if (schema['undefined'].targetNamespace) {
                schemaTNS = schema['undefined'].targetNamespace;
            }

            if (schema['undefined'].fromImport && schemaImportMap[schemaTNS]) {
                R.detail(req, g.http(u.r(req)).f(
                  'The schema \'%s\' was imported from multiple files, %s and %s.' +
                  ' All imports are processed, but there could be problems if schema constructs are declared in multiple files.',
                  schemaTNS, schema['undefined'].fileName, schemaImportMap[schemaTNS]['undefined'].fileName));
            }
            if (schema['undefined'].fromImport) {
                schemaImportMap[schemaTNS] = schema;
            }
            if (schemaTNS === '' && !(schema['undefined'].fromImport || schema['undefined'].fromInclude)) {
                // Schema without targetNamespace is only allowed if no elements, types, etc.
                if (schema.element || schema.complexType || schema.simpleType || schema.group || schema.attribute || schema.attributeGroup) {
                    R.error(req, g.http(u.r(req)).f(
                      'A schema without a targetNamspace was found in file %s.  This is a violation of a WS-I Rule (R2105 All xsd:schema elements contained in a wsdl:types element of a DESCRIPTION MUST have a targetNamespace attribute with a valid and non-null value, UNLESS the xsd:schema element has xsd:import and/or xsd:annotation as its only child element(s).).',
                      schema['undefined'].fileName));
                }
            }

            if (schema['undefined'].elementFormDefault && schema['undefined'].elementFormDefault == 'qualified') {
                qualified = true;
            }
            if (schema['undefined'].attributeFormDefault && schema['undefined'].attributeFormDefault == 'qualified') {
                qualifiedAttr = true;
            }
            // The version attribute is provided by schema, but it has no semanitics associated with it.
            // I suppose there is a possibility that a wsdl could have imports of different versions of a schema.
            // However, I have not seen that problem in practice.
            // For now, I don't see any reason to report version use or mis-use.
            // if (schema['undefined'].version) {
            //    R.info(req, 'The version, ' + schema['undefined'].version + ', is ignored on ' + schemaTNS);
            // }

            // blockDefault is used in the wse security namespace, but we don't care about that usage because
            // we consider wse security items as built-ins.
            // Warn about any other usage of block default.
            if (schema['undefined'].blockDefault && !u.wseRelatedNamespace(schemaTNS) && !u.wsAddrRelatedNamespace(schemaTNS)) {
                R.warning(req, g.http(u.r(req)).f('The \'blockDefault\' value, %s, is ignored on schema %s.', schema['undefined'].blockDefault, schemaTNS));
            }
            if (schema['undefined'].finalDefault) {
                R.info(req, g.http(u.r(req)).f('The \'finalDefault\' value, %s, is ignored on schema %s.', schema['undefined'].finalDefault, schemaTNS));
            }
        }
        let schemaNamespaces = schema.wsdlXmlns ? schema.wsdlXmlns : namespaces;
        let implicitHeaderSchema = schema['undefined'].implicitHeaderSchema;

        // Get the prefix for the schema.  If none is defined, or if it is the internal value (__tns__) then add
        // an acceptable prefix.
        let prefix = u.getPrefixForNamespace(schemaTNS, schemaNamespaces);
        if (!prefix || prefix === '__tns__') {
            schemaNamespaces['defaultTNS'] = schemaTNS;
            prefix = u.getPrefixForNamespace(schemaTNS, schemaNamespaces);
        }

        if ('redefine' in schema) {
            R.error(req, g.http(u.r(req)).f('The \'redefine\' element and its contents are ignored.'));
        }
        if ('notation' in schema) {
            R.info(req, g.http(u.r(req)).f('The \'notation\' element is ignored.'));
        }
        if (schema.include) {
            schema.include = u.makeSureItsAnArray(schema.include);
            for (let j = 0; j < schema.include.length; j++) {
                let inc = schema.include[j];
                if (inc['undefined'].chameleon) {
                    R.warning(req, g.http(u.r(req)).f('The schema, \'%s\' includes a schema with no targetNamespace. ' +
                    'This \'chameleon include\' may not be mapped correctly. ' +
                    'The schemaLocation of the included file is \'%s\'.', schemaTNS, inc['undefined'].schemaLocation));
                }
            }
        }
        let versionPrefix = u.getPrefixForNamespace(SCHEMA_VERSIONING_NS, schema.xmlns, true) ||
                            u.getPrefixForNamespace(SCHEMA_VERSIONING_NS, namespaces, true);
        if (versionPrefix) {
            R.info(req, g.http(u.r(req)).f('Only XML Schema 1.0 is supported.  This is a violation of a WS-I Rule (R4004 A DESCRIPTION MUST use version 1.0 of the eXtensible Markup Language W3C Recommendation). The versioning namespace is igonored: xmlns:%s=\'%s\'.',
              versionPrefix, SCHEMA_VERSIONING_NS));
        }
        if (schema.complexType) {
            let defComplexTypes = u.makeSureItsAnArray(schema.complexType);
            let complexLen = defComplexTypes.length;
            for (let j = 0; j < complexLen; j++) {
                let complexType = defComplexTypes[j];
                let nsName = resolveNsName(complexType['undefined'].name, 'typedef', schemaTNS, namespaces);
                let isAbstract = complexType['undefined'].abstract && complexType['undefined'].abstract.toLowerCase() === 'true';
                let tagInfo = {
                    prefix: prefix,
                    name: complexType['undefined'].name,
                    abstract: isAbstract
                };

                // If TypeA has block='extension' and TypeB extends A then
                // then <element name="myA" type="TypeA" /> cannot be substituted with anything of TypeB.
                // We don't enforce this so there is a message.
                // To enforce this, we would need to divide the polymorphic hierarchy so that restrictions or
                // extensions below TypeA are disconnected from TypeA.
                // I have not seen anyone use block, so such work is not important for now.
                if (complexType['undefined'].block) {
                    annotateInfo(complexType, g.http(u.r(req)).f('The block property is not enforced on %s.', nsName));
                }

                // If TypeA has final='extension' and TypeB extends A then
                // then soap (or us), should put out a message.
                // We don't enforce this, but I am assuming that customer's have already done this kind
                // of verification.  So for now we will not put out a message.
                /*
                if (complexType['undefined'].final) {
                    annotateInfo(complexType, g.http(u.r(req)).f('The final property is not enforced on ', nsName));
                }*/
                dictEntry[nsName] = {
                    schema: complexType,
                    schemaType: 'complex',
                    for: 'typedef',
                    tagInfo: tagInfo,
                    tns: schemaTNS,
                    qualified: qualified,
                    qualifiedAttr: qualifiedAttr,
                    xmlns: schema.xmlns
                };
                let refNSName = resolveNsName(complexType['undefined'].name, 'type', schemaTNS, namespaces);
                dictEntry[refNSName] = u.deepClone(dictEntry[nsName]);
                dictEntry[refNSName].schemaType = 'typeOf';
                dictEntry[refNSName].typeNSName = nsName;
                dictEntry[refNSName].for = 'type';
                dictEntry[nsName].refNSName = refNSName;
            }
        }
        if (schema.simpleType) {
            let defSimpleTypes = u.makeSureItsAnArray(schema.simpleType);
            let simpleLen = defSimpleTypes.length;
            for (let j = 0; j < simpleLen; j++) {
                let simpleType = defSimpleTypes[j];
                let nsName = resolveNsName(simpleType['undefined'].name, 'typedef', schemaTNS, namespaces);
                let tagInfo = {
                    prefix: prefix,
                    name: simpleType['undefined'].name,
                };
                dictEntry[nsName] = {
                    schema: simpleType,
                    schemaType: 'simple',
                    for: 'typedef',
                    tns: schemaTNS,
                    tagInfo: tagInfo,
                    qualified: qualified,
                    qualifiedAttr: qualifiedAttr,
                    xmlns: schema.xmlns
                };
                if (simpleType.list) {
                    // xsd:list is a whitespace delimited string of the types defined in the itemType attribute.
                    // This is an uncommon usage, and the best approach is to map to a string.
                    let xsdPrefixes = getXSDPrefixes(namespaces);
                    let stringType = xsdPrefixes.length > 0 ? xsdPrefixes[0] + ':string' : 'string';
                    dictEntry[nsName].schema['undefined'].type = stringType;
                }
                let refNSName = resolveNsName(simpleType['undefined'].name, 'type', schemaTNS, namespaces);
                dictEntry[refNSName] = u.deepClone(dictEntry[nsName]);
                dictEntry[refNSName].schemaType = 'typeOf';
                dictEntry[refNSName].typeNSName = nsName;
                dictEntry[refNSName].for = 'type';
                dictEntry[nsName].refNSName = refNSName;
            }
        }
        if (schema.element) {
            schemaElements[schemaTNS] = schemaElements[schemaTNS] || [];
            let defElements = u.makeSureItsAnArray(schema.element);
            let elemLen = defElements.length;
            for (let j = 0; j < elemLen; j++) {
                let element = defElements[j];
                let elemName = element['undefined'].name;
                let nsName = resolveNsName(elemName, 'element', schemaTNS, namespaces);
                schemaElements[schemaTNS].push(nsName);

                // If TypeA and TypeB extends A then
                // then <element name="myA" block="extension" type="TypeA" /> cannot be substituted with anything of TypeB.
                // We don't enforce this so there is a message.
                // To enforce this, we would need to divide the polymorphic hierarchy so that restrictions or
                // extensions below TypeA are disconnected from TypeA.
                // I have not seen anyone use block, so such work is not important for now.
                // Note that block="substitution" is also not enforced
                if (element['undefined'].block) {
                    R.warning(req, g.http(u.r(req)).f('The block property is not enforced on %s.', nsName));
                }

                // If TypeA, and TypeB extends TypeA and
                // <element name="myA" final="extension" type="TypeA" />
                // then soap (or us), should put out a message.
                // This is a static error.
                if (element['undefined'].final) {
                    R.info(req, g.http(u.r(req)).f('The final property is not enforced on %s.', nsName));
                }

                let isAbstract = element['undefined'].abstract && element['undefined'].abstract.toLowerCase() === 'true';
                let isNillable = element['undefined'].nillable && element['undefined'].nillable.toLowerCase() === 'true';
                let defaultValue = element['undefined'].default || element['undefined'].final;

                // capture element namespaces
                let tagInfo;
                if (nsName) {
                    tagInfo = {
                        xml: {
                            ns: schemaTNS,
                            prefix: prefix
                        },
                        nillable: isNillable,
                        abstract: isAbstract,
                        default: defaultValue,
                        prefix: prefix,
                        name: elemName,
                        forImplicitHeader: implicitHeaderSchema
                    };
                }
                if (!('complexType' in element) &&
                    !('simpleType' in element) &&
                    !(element['undefined'] &&
                          (element['undefined'].type || element['undefined'].substitutionGroup))) {
                    // Special case of <xsd:element name="foo" />
                    // This is treated as element with name foo of anyType
                    dictEntry[nsName] = {
                        schema: null,
                        tagInfo: tagInfo,
                        for: 'element',
                        schemaType: 'anyType',
                        suppressXSIType: true,
                        tns: schemaTNS,
                        qualified: qualified,
                        xmlns: schema.xmlns
                    };
                } else if ('complexType' in element) {
                    // Special case of complexType that is empty
                    if (!element.complexType) {
                        element.complexType = {};
                    }
                    if (!dictEntry[nsName]) {
                        dictEntry[nsName] = {
                            schema: element.complexType,
                            tagInfo: tagInfo,
                            for: 'element',
                            schemaType: 'complex',
                            nestedType: true,
                            tns: schemaTNS,
                            qualified: qualified,
                            qualifiedAttr: qualifiedAttr,
                            xmlns: schema.xmlns
                        };
                    }
                } else if (element.simpleType) {
                    if (!dictEntry[nsName]) {
                        dictEntry[nsName] = {
                            schema: element.simpleType,
                            tagInfo: tagInfo,
                            for: 'element',
                            schemaType: 'simple',
                            nestedType: true,
                            tns: schemaTNS,
                            qualified: qualified,
                            qualifiedAttr: qualifiedAttr,
                            xmlns: schema.xmlns
                        };
                    }
                } else {
                    var isXSD = isXSDType(element['undefined'].type, namespaces, schema.xmlns);
                    var isAnyType = isXSDAnyType(element['undefined'].type, namespaces, schema.xmlns);

                    if (isAnyType) {
                        dictEntry[nsName] = {
                            schema: null,
                            tagInfo: tagInfo,
                            for: 'element',
                            schemaType: 'anyType',
                            suppressXSIType: true,
                            tns: schemaTNS,
                            qualified: qualified,
                            xmlns: schema.xmlns
                        };
                    } else if (isXSD) {
                        // element is a primitive type - generate a fake simple type
                        if (!dictEntry[nsName]) {
                            dictEntry[nsName] = {
                                schema: {
                                    undefined: {
                                        name: elemName
                                    },
                                    restriction: {
                                        undefined: {
                                            base: element['undefined'].type
                                        }
                                    }
                                },
                                tagInfo: tagInfo,
                                for: 'element',
                                schemaType: 'simple',
                                suppressXSIType: true, // Suppress XSIType for primitives
                                tns: schemaTNS,
                                qualified: qualified,
                                qualifiedAttr: qualifiedAttr,
                                xmlns: schema.xmlns
                            };
                        }
                    } else {
                        let elemType = resolveNameInNamespace(element['undefined'].type, 'type', schema.xmlns, namespaces, schemaTNS);
                        if (!dictEntry[nsName]) {
                            dictEntry[nsName] = {
                                schema: element,
                                tagInfo: tagInfo,
                                for: 'element',
                                schemaType: 'typeOf',
                                typeNSName: elemType,
                                tns: schemaTNS,
                                qualified: qualified,
                                qualifiedAttr: qualifiedAttr,
                                xmlns: schema.xmlns
                            };
                        }
                    }
                }
                if (element['undefined'].substitutionGroup) {
                    // record the substitution group information in a map
                    let groupGroupNS = resolveNameInNamespace(element['undefined'].substitutionGroup, 'element', schema.xmlns, namespaces, schemaTNS);

                    if (!element['undefined'].type && !element.complexType && !element.simpleType) {
                        // element has no type or content.
                        // The content of the referenced group is used in this case according to the spec.
                        dictEntry[nsName].typeNSName = groupGroupNS;
                        dictEntry[nsName].schemaType = 'typeOf';
                    }
                    if (!substitutions[groupGroupNS]) {
                        substitutions[groupGroupNS] = [];
                    }
                    substitutions[groupGroupNS].push(nsName);
                }
            } // end for
        }
        if (schema.group) {
            // groups are stored in the groups array, which will be accessed later and processed by inlining
            // the constructs in the group.
            let defGroups = u.makeSureItsAnArray(schema.group);
            let gpLen = defGroups.length;
            for (let j = 0; j < gpLen; j++) {
                let groupType = defGroups[j];
                let nsName = resolveNsName(groupType['undefined'].name, 'group', schemaTNS, namespaces);
                if (!dictEntry[nsName]) {
                    dictEntry[nsName] = {
                        schema: groupType,
                        tagInfo: {
                            xml: {
                                ns: schemaTNS,
                                prefix: prefix
                            },
                            prefix: prefix,
                            name: groupType['undefined'].name,
                        },
                        for: 'group',
                        tns: schemaTNS,
                        qualified: qualified,
                        qualifiedAttr: qualifiedAttr,
                        xmlns: schema.xmlns
                    };
                }
            } // end for
        }
        if (schema.attributeGroup) {
            // attribute groups are stored in an array, which will be accessed later and processed by inlining
            // the constructs in the group.
            let defAttrGroups = u.makeSureItsAnArray(schema.attributeGroup);
            for (let j = 0; j < defAttrGroups.length; j++) {
                let attrGroupType = defAttrGroups[j];
                let nsName = resolveNsName(attrGroupType['undefined'].name, 'attributeGroup', schemaTNS, namespaces);
                if (!dictEntry[nsName]) {
                    dictEntry[nsName] = {
                        schema: attrGroupType,
                        tagInfo: {
                            xml: {
                                ns: schemaTNS,
                                prefix: prefix
                            },
                            prefix: prefix,
                            name: attrGroupType['undefined'].name,
                        },
                        for: 'attributeGroup',
                        tns: schemaTNS,
                        qualified: qualified,
                        qualifiedAttr: qualifiedAttr,
                        xmlns: schema.xmlns
                    };
                }
            } // end for
        }

        if (schema.attribute) {
            schemaAttributes[schemaTNS] = schemaAttributes[schemaTNS] || [];
            let attrs = u.makeSureItsAnArray(schema.attribute);
            for (let j = 0; j < attrs.length; j++) {
                let attr = attrs[j];
                let attrName = attr['undefined'].name;
                let nsName = resolveNsName(attrName, 'attribute', schemaTNS, namespaces);
                schemaAttributes[schemaTNS].push(nsName);

                let defaultValue = attr['undefined'].default || attr['undefined'].final;
                let tagInfo;
                if (nsName) {
                    tagInfo = {
                        xml: {
                            ns: schemaTNS,
                            prefix: prefix
                        },
                        default: defaultValue,
                        prefix: prefix,
                        name: attr['undefined'].name,
                    };
                }
                // Root attribute is defined:
                // 1) inline
                // 2) with a built-in type, or
                // 3) with a non-built-in type

                if (attr.simpleType) {
                    // 1) Root attribute is defined inline
                    if (!dictEntry[nsName]) {
                        dictEntry[nsName] = {
                            schema: attr.simpleType,
                            tagInfo: tagInfo,
                            for: 'attribute',
                            schemaType: 'simple',
                            tns: schemaTNS,
                            qualified: true,
                            qualifiedAttr: qualifiedAttr,
                            xmlns: schema.xmlns
                        };
                    }
                } else {
                    let isAttrXSD = isXSDType(attr['undefined'].type, namespaces, schema.xmlns);

                    if (isAttrXSD) {
                        // 2) attribute is a primitive type - generate a fake simple type
                        if (!dictEntry[nsName]) {
                            dictEntry[nsName] = {
                                schema: {
                                    undefined: {
                                        name: attrName
                                    },
                                    restriction: {
                                        undefined: {
                                            base: attr['undefined'].type
                                        }
                                    }
                                },
                                schemaType: 'simple',
                                for: 'attribute',
                                tagInfo: tagInfo,
                                tns: schemaTNS,
                                qualified: true,
                                qualifiedAttr: qualifiedAttr,
                                xmlns: schema.xmlns
                            };
                        }
                    } else {
                        // 3) Attribute is defined with a non-bult-in type
                        var attrType = resolveNameInNamespace(attr['undefined'].type, 'type', schema.xmlns, namespaces, schemaTNS);
                        if (attrType) {
                            if (!dictEntry[nsName]) {
                                dictEntry[nsName] = {
                                    schema: attr,
                                    schemaType: 'typeOf',
                                    typeNSName: attrType,
                                    for: 'attribute',
                                    tagInfo: tagInfo,
                                    tns: schemaTNS,
                                    qualified: true,
                                    qualifiedAttr: qualifiedAttr,
                                    xmlns: schema.xmlns
                                };
                            }
                        }
                    }
                }
            } // end for
        } // end attribute
    } // end for

    // The dictionary
    let dict = {
        dictEntry: dictEntry,
        schemaElements: schemaElements,  // key is schema namespace, value is list of nsNames for elements
        schemaAttributes: schemaAttributes,  // key is schema namespace, value is list of nsNames for attributes
        pathInfo: [],
        wsdlTNS: wsdlTNS,
        req: req,
        complexityCount: 0 // This count is increased when certain functions are called.
    };

    for (let nsName in substitutions) {
        let dictEntry = dict.dictEntry[nsName];
        if (dictEntry) {
            let list = [ ];
            getSubstitutions(substitutions, list, nsName);
            let subGroupNSName = resolveNsName(dictEntry.tagInfo.name, 'substitutionGroup', dictEntry.tns, namespaces);
            let subGroupDictEntry = u.deepClone(dictEntry);
            dict.dictEntry[subGroupNSName] = subGroupDictEntry;
            subGroupDictEntry.nsNames = list;
            subGroupDictEntry.for = 'substitutionGroup';
            delete subGroupDictEntry.typeOf;
            delete subGroupDictEntry.typeNSName;
            delete subGroupDictEntry.schemaType;
            dictEntry.substitutions = true;
        }
    }

    // calculate all sub types
    for (let nsName in dict.dictEntry) {
        let dictEntry = dict.dictEntry[nsName];
        if (dictEntry.schema && dictEntry.for === 'typedef') {
            let ext = null;
            if (dictEntry.nestedType) {
                // Only consider root complexTypes for polymorphic subTypes.
                // Don't consider nested types of root elements when determining subTypes
            } else if (dictEntry.schema.complexContent && dictEntry.schema.complexContent.extension) {
                ext = dictEntry.schema.complexContent.extension;
            } else if (dictEntry.schema.simpleContent && dictEntry.schema.simpleContent.extension) {
                ext = dictEntry.schema.simpleContent.extension;
            } else {
                // According to the specification, restrictions should also be considered as part of
                // the polymorphic hierarchy.  But this is difficult to render because a restriction
                // actually removes or changes the content in the hierarchy.  We have chosen to render
                // the content correctly, but exclude the restricted type from polymorphism.
                // This is probably the best approach since it is very rare to see this usage in
                // actual wsdls.
                /*
                if (dictEntry.schema.complexContent && dictEntry.schema.complexContent.restriction) {
                    let rst = dictEntry.schema.complexContent.restriction;
                    R.info(req,
                      g.http(u.r(req)).f('The type %s is a complexContent restriction of %s. ' +
                      'The type\'s content is mapped, but the type won\'t be a polymorphic derivative of %s.', nsName, rst['undefined'].base, rst['undefined'].base));
                }
                if (dictEntry.schema.simpleContent && dictEntry.schema.simpleContent.restriction) {
                    let rst = dictEntry.schema.simpleContent.restriction;
                    R.info(req,
                      g.http(u.r(req)).f('The type %s is a simpleContent restriction of %s. ' +
                      'The type\'s content is mapped, but the type won\'t be a polymorphic derivative of %s.', nsName, rst['undefined'].base, rst['undefined'].base));
                }
                */
            }
            if (ext) {
                let baseType = bestMatch(ext['undefined'].base, 'typedef', dictEntry, dict, namespaces);
                if (baseType) {
                    if (dict.dictEntry[baseType]) {
                        // store list of sub types of the base type
                        dict.dictEntry[baseType].subTypes = dict.dictEntry[baseType].subTypes || [];
                        dict.dictEntry[baseType].subTypes.push(nsName);
                        dict.dictEntry[nsName].ancType = baseType;
                    }
                }
            }
        }
    } // end for
    // Calculate the list of all of the descendents
    for (let nsName in dict.dictEntry) {
        if (dictEntry[nsName].subTypes) {
            dictEntry[nsName].allDescendents = allDescendents(nsName, dictEntry);
        }
    }
    return dict;
}

function allDescendents(nsName, dictEntry, descendents) {
    descendents = descendents || [];
    if (!dictEntry[nsName].subTypes) {
        return descendents;
    }
    let test = _.union(descendents, dictEntry[nsName].subTypes, _.isEqual);
    if (test.length == descendents.length) {
        return descendents;
    } else {
        descendents = u.deepClone(test);
    }
    for (let i = 0; i < dictEntry[nsName].subTypes.length; i++) {
        let subType = dictEntry[nsName].subTypes[i];
        descendents = allDescendents(subType, dictEntry, descendents);
    }
    return descendents;
}


/**
* Populate list with all of the substitutions of nsName.
* @param substitions input map of substituionGroups
* @param list to poplulate
* @param nsName
*/
function getSubstitutions(substitutions, list, nsName) {
    list.push(nsName);
    if (substitutions[nsName]) {
        let subList = substitutions[nsName];
        for (let i = 0; i < subList.length; i++) {
            let s = subList[i];
            if (list.indexOf(s) < 0) {
                list.push(s);
                if (substitutions[s]) {
                    getSubstitutions(substitutions, list, s);
                }
            }
        }
    }
}

/**
* prune schemaList (remove duplicates and process chameleons)
* prior to dictionary build
* @param scheamList
*/
function pruneSchemas(schemaList, req) {
    // Remove duplicate schemas for the same namespace and location
    let dupMap = {};
    let schemaList2 = [];
    for (let i = 0; i < schemaList.length; i++) {
        let schema = schemaList[i];

        let key = '';
        if (!schema['undefined']) {
            schema['undefined'] = {};
        }
        if (schema['undefined'].targetNamespace) {
            key += 'tns:' + schema['undefined'].targetNamespace + ' ';
        }
        if (schema['undefined'].fileName) {
            key += 'location:' + schema['undefined'].fileName;
        }
        if (!schema['undefined'].fromImport && !schema['undefined'].fromInclude) {
            key += 'nested:' + i;
        }

        if (key == '') {
            schemaList2.push(schema);
        } else if (dupMap[key]) {
            if (schema['undefined'].fromImport) {
                dupMap[key]['undefined'].fromImport = true;
            }
            if (schema['undefined'].fromInclude) {
                dupMap[key]['undefined'].fromInclude = true;
            }
        } else {
            dupMap[key] = schema;
            schemaList2.push(schema);
        }
    }
    // Remove chameleon includes
    let schemaList3 = [];
    let chameleonSchemas = {};
    for (let i = 0; i < schemaList2.length; i++) {
        let schema = schemaList2[i];
        if (schema['undefined'].fromInclude && !schema['undefined'].targetNamespace) {
            // Chameleon include
            chameleonSchemas[schema['undefined'].fileName] = schema;
            if (schema['undefined'].fromImport) {
                schemaList3.push(schema);
            }
        } else {
            schemaList3.push(schema);
        }
    }

    // A chameleon schema uses the parent's namespace.
    // So we will make duplicates of the chameleon schemas for each unique include.
    if (Object.keys(chameleonSchemas).length > 0) {
        let len = schemaList3.length;
        for (let i = 0; i < len; i++) {
            let schema = schemaList3[i];

            if (!schema['undefined'].targetNamespace) {
                R.warning(req, g.http(u.r(req)).f(
                  'A schema in file \'%s\' has no targetNamespace. ' +
                  'It is not a best practice to define schemas without a targetNamespace. ' +
                  'The API Connect will interpret the constructs in this file as having no namespace. ',
                  schema['undefined'].fileName));
            }
            if (schema.include) {
                schema.include = u.makeSureItsAnArray(schema.include);
                let chameleons = {};
                for (let j = 0; j < schema.include.length; j++) {
                    let inc = schema.include[j];
                    if (inc['undefined'].schemaLocation) {
                        chameleons = getChamelionSchemas(chameleonSchemas, inc['undefined'].schemaLocation, chameleons);
                    }
                }
                let fileNames = Object.keys(chameleons);
                if (fileNames.length > 0) {
                    R.warning(req, g.http(u.r(req)).f(
                      'The schema, \'%s\' includes schemas with no targetNamespace. ' +
                      'This type of include is often called a \'chameleon include\', and it is not a best practice. ' +
                      'The API Connect will use the namespace \'%s\' while processing these files. ' +
                      'The files are \'%s\'.', schema['undefined'].targetNamespace, schema['undefined'].targetNamespace, fileNames));
                }
                for (let fileName in chameleons) {
                    let newSchema = u.deepClone(chameleons[fileName]);
                    newSchema['undefined'].targetNamespace = schema['undefined'].targetNamespace;
                    newSchema.xmlns = newSchema.xmlns || {};
                    newSchema.xmlns[''] = schema['undefined'].targetNamespace;
                    schemaList3.push(newSchema);
                }
            }
        }
    }
    return schemaList3;
}

/**
* @param allChameleons map of schemas with no targetNamespace
* @param schemaLocation of the include
* @return all chameleon schemas (even those from ancestor includes)
*/
function getChamelionSchemas(allChameleons, schemaLocation, chameleons) {
    chameleons = chameleons || {};
    let fileName = u.fileNameFromPath(schemaLocation);
    if (allChameleons[fileName] && !chameleons[fileName]) {
        let schema = allChameleons[fileName];
        chameleons[fileName] = schema;
        if (schema.include) {
            schema.include = u.makeSureItsAnArray(schema.include);
            for (let j = 0; j < schema.include.length; j++) {
                let inc = schema.include[j];
                if (inc['undefined'].schemaLocation) {
                    chameleons = getChamelionSchemas(allChameleons, inc['undefined'].schemaLocation, chameleons);
                }
            }
        }
    }
    return chameleons;
}

/**
 * Add predefined NSNames into the dictionary.
 */
function addPredefinedNSNames(dictEntry, detectedWSAddressing) {
    let nsName = 'lang_attribute_xml';
    // Add the xml:lang attribute that is defined by the xml namespace spec
    if (!dictEntry[nsName]) {
        dictEntry[nsName] = {
            schema: {
                undefined: {
                    name: 'lang'
                },
            },
            schemaType: 'predefined',
            qualified: true, // Do this to prevent the xml prefix from being junked
            for: 'predefined',
            definition: {
                xml: {
                    name: 'lang',
                    namespace: 'http://www.w3.org/XML/1998/namespace',
                    prefix: 'xml', // Special prefix defined by xsd
                    attribute: true
                },
                type: 'string'
            }
        };
    }
    nsName = 'base_attribute_xml';
    // Add the xml:base attribute that is defined by the xml namespace spec
    if (!dictEntry[nsName]) {
        dictEntry[nsName] = {
            schema: {
                undefined: {
                    name: 'base'
                },
            },
            schemaType: 'predefined',
            qualified: true, // Do this to prevent the xml prefix from being junked
            for: 'predefined',
            definition: {
                xml: {
                    name: 'base',
                    namespace: 'http://www.w3.org/XML/1998/namespace',
                    prefix: 'xml', // Special prefix defined by xsd
                    attribute: true
                },
                type: 'string'
            }
        };
    }
    nsName = 'space_attribute_xml';
    // Add the xml:space attribute that is defined by the xml namespace spec
    if (!dictEntry[nsName]) {
        dictEntry[nsName] = {
            schema: {
                undefined: {
                    name: 'space'
                },
            },
            schemaType: 'predefined',
            qualified: true, // Do this to prevent the xml prefix from being junked
            for: 'predefined',
            definition: {
                xml: {
                    name: 'space',
                    namespace: 'http://www.w3.org/XML/1998/namespace',
                    prefix: 'xml', // Special prefix defined by xsd
                    attribute: true
                },
                type: 'string',
                enum: [ 'default', 'preserve' ]
            }
        };
    }
    nsName = 'id_attribute_xml';
    // Add the xml:id attribute that is defined by the xml namespace spec
    if (!dictEntry[nsName]) {
        dictEntry[nsName] = {
            schema: {
                undefined: {
                    name: 'id'
                },
            },
            schemaType: 'predefined',
            qualified: true, // Do this to prevent the xml prefix from being junked
            for: 'predefined',
            definition: {
                xml: {
                    name: 'id',
                    namespace: 'http://www.w3.org/XML/1998/namespace',
                    prefix: 'xml', // Special prefix defined by xsd
                    attribute: true
                },
                type: 'string'
            }
        };
    }

    nsName = 'SubCode__SOAP12';
    if (!dictEntry[nsName]) {

        // SubCode is a self-referencing structure (which is the way schema does linked lists)
        // In practice, it is likely that an actual subcode will only have 1 or 2 links.
        // The gateway (current design) will only proceed one level deep in a self-reference structure.
        // For these reasons, a few layers of the structure are inlined prior to the self-reference.
        dictEntry[nsName] = {
            schema: {
                undefined: {
                    name: 'SubCode'
                },
            },
            schemaType: 'predefined',
            qualified: true,
            for: 'predefined',
            definition: {
                xml: {
                    namespace: 'http://www.w3.org/2003/05/soap-envelope',
                    prefix: 'soapenv',
                },
                type: 'object',
                properties: {
                    Value: {
                        type: 'string',
                    },
                    SubCode: {
                        xml: {
                            namespace: 'http://www.w3.org/2003/05/soap-envelope',
                            prefix: 'soapenv',
                        },
                        type: 'object',
                        properties: {
                            Value: {
                                type: 'string',
                            },
                            SubCode: {
                                xml: {
                                    namespace: 'http://www.w3.org/2003/05/soap-envelope',
                                    prefix: 'soapenv',
                                },
                                type: 'object',
                                properties: {
                                    Value: {
                                        type: 'string',
                                    },
                                    SubCode: {
                                        $ref: '#/definitions/SubCode__SOAP12'
                                    }
                                },
                            }
                        },
                    }
                },
                required: [ 'Value' ]
            }
        };
    }

    if (detectedWSAddressing) {
        // Add the core WSA elements
        if (!dictEntry['Action__WSA']) {
            dictEntry['Action__WSA'] = {
                schema: {
                    undefined: {
                        name: 'Action'
                    },
                },
                schemaType: 'predefined',
                qualified: true,
                for: 'predefined',
                definition: {
                    xml: {
                        namespace: 'http://www.w3.org/2005/08/addressing',
                        prefix: 'wsa',
                        name: 'Action'
                    },
                    type: 'string'
                }
            };
        }
        if (!dictEntry['To__WSA']) {
            dictEntry['To__WSA'] = {
                schema: {
                    undefined: {
                        name: 'To'
                    },
                },
                schemaType: 'predefined',
                qualified: true,
                for: 'predefined',
                definition: {
                    xml: {
                        namespace: 'http://www.w3.org/2005/08/addressing',
                        prefix: 'wsa',
                        name: 'To'
                    },
                    type: 'string'
                }
            };
        }
        if (!dictEntry['MessageID__WSA']) {
            dictEntry['MessageID__WSA'] = {
                schema: {
                    undefined: {
                        name: 'MessageID'
                    },
                },
                schemaType: 'predefined',
                qualified: true,
                definition: {
                    xml: {
                        namespace: 'http://www.w3.org/2005/08/addressing',
                        prefix: 'wsa',
                        name: 'MessageID'
                    },
                    type: 'string'
                }
            };
        }
        if (!dictEntry['ReplyTo__WSA']) {
            dictEntry['ReplyTo__WSA'] = {
                schema: {
                    undefined: {
                        name: 'ReplyTo'
                    },
                },
                schemaType: 'predefined',
                qualified: true,
                for: 'predefined',
                definition: {
                    xml: {
                        namespace: 'http://www.w3.org/2005/08/addressing',
                        prefix: 'wsa',
                        name: 'ReplyTo'
                    },
                    type: 'object',
                    properties: {
                        Address: {
                            xml: {
                                namespace: 'http://www.w3.org/2005/08/addressing',
                                prefix: 'wsa'
                            },
                            type: 'string'
                        }
                    }
                }
            };
        }

        if (!dictEntry['FaultTo__WSA']) {
            dictEntry['FaultTo__WSA'] = {
                schema: {
                    undefined: {
                        name: 'FaultTo'
                    },
                },
                schemaType: 'predefined',
                qualified: true,
                for: 'predefined',
                definition: {
                    xml: {
                        namespace: 'http://www.w3.org/2005/08/addressing',
                        prefix: 'wsa',
                        name: 'FaultTo'
                    },
                    type: 'object',
                    properties: {
                        Address: {
                            xml: {
                                namespace: 'http://www.w3.org/2005/08/addressing',
                                prefix: 'wsa'
                            },
                            type: 'string'
                        }
                    }
                }
            };
        }
    }
}


/**
 * Add parser error message as documentation in the schema documentation
 * The message will appear in the corresponding swagger description.
 */
function annotateInfo(target, message) {
    if (!target) {
        return;
    }
    if (!target.annotation) {
        target.annotation = {};
    }
    if (!target.annotation.apic) {
        target.annotation.apic = {
            info: [],
            warning: [],
            error: [],
        };
    }

    if (target.annotation.apic.info.indexOf(message) < 0) {
        target.annotation.apic.info.push(message);
    }
}

/**
 * Add parser error message as documentation in the schema documentation
 * The message will appear in the corresponding swagger description.
 */
function annotateWarning(target, message) {
    if (!target) {
        return;
    }
    if (!target.annotation) {
        target.annotation = {};
    }
    if (!target.annotation.apic) {
        target.annotation.apic = {
            info: [],
            warning: [],
            error: [],
        };
    }

    if (target.annotation.apic.warning.indexOf(message) < 0) {
        target.annotation.apic.warning.push(message);
    }
}

/**
 * Add parser error message as documentation in the schema documentation
 * The message will appear in the corresponding swagger description.
 */
function annotateError(target, message) {
    if (!target) {
        return;
    }
    if (!target.annotation) {
        target.annotation = {};
    }
    if (!target.annotation.apic) {
        target.annotation.apic = {
            info: [],
            warning: [],
            error: [],
        };
    }

    if (target.annotation.apic.error.indexOf(message) < 0) {
        target.annotation.apic.error.push(message);
    }
}

/**
 * Resolve the name to an NS Name from name and target namespace.
 * The prefix is chosen from the namespaces map.
 * If the name is for a root attribute (versus a type or element)
 * then isAttribute is set.
 */
function resolveNsName(name, kind, tns, namespaces) {
    var ret = name;
    checkKind(kind);
    if (kind !== 'wsdl') {
        ret += '_' + kind;
    }
    if (tns) {
        var prefix = u.getPrefixForNamespace(tns, namespaces);
        if (prefix && (prefix !== '__tns__')) {
            ret += '_' + prefix;
        }
    }
    return ret;
}

/**
* Make sure the kind is appropriate, otherwise throw internal error.
*/
function checkKind(kind) {
    let allowed = [ 'wsdl', 'element', 'typedef', 'type', 'attribute', 'group', 'attributeGroup', 'substitutionGroup' ];
    if (!kind) {
        throw new Error('kind is not set');
    } else {
        if (_.indexOf(allowed, kind) < 0) {
            throw new Error('kind is not appropriate ' + kind);
        }
    }
}

/**
* Return the list of prefixes defined for the xml schema namespace.
*/
function getXSDPrefixes(namespaces) {
    var ret = [];
    for (var key in namespaces) {
        var namespace = namespaces[key];
        if (namespace == 'http://www.w3.org/2001/XMLSchema') {
            ret.push(key);
        }
    } // end for
    return ret;
}


// Returns the fully qualified nsName for the given name matched with the local
// namespace but resolved to the global namespace.
// @param localNamespaces is the namespace map closest to the reference (probably the schema or message namespace)
// @param globalNamespaces is the namespace map for the whole generation
function resolveNameInNamespace(name, kind, localNamespaces, globalNamespaces, tns, dict) {
    complexityLimitCheck(dict);
    var nsName = name;
    checkKind(kind);
    if (kind !== 'wsdl') {
        nsName += '_' + kind;
    }
    if (name) {
        var index = name.indexOf(':');
        if (index != -1) {
            var rawPrefix = name.substring(0, index);
            nsName = name.substr(index + 1);
            if (kind !== 'wsdl') {
                nsName += '_' + kind;
            }
            var prefix;
            var namespace;
            // the given name should always be mapped through the local namespace first, if supplied
            if (rawPrefix == 'xml') {  // xml is a reserved prefix
                nsName += '_' + rawPrefix;
            } else if (localNamespaces && localNamespaces[rawPrefix]) {
                namespace = localNamespaces[rawPrefix];
                prefix = u.getPrefixForNamespace(namespace, globalNamespaces);
                nsName += '_' + prefix;
            } else if (globalNamespaces && globalNamespaces[rawPrefix]) {
                namespace = globalNamespaces[rawPrefix];
                prefix = u.getPrefixForNamespace(namespace, globalNamespaces);
                nsName += '_' + prefix;
            } else {
                // Caller is responsible for determining if this is an error.
                nsName += '_' + rawPrefix;
            }
        } else {
            // If there is no prefix, then this is a case where the default namespace is used.
            // Get the all of the prefixes in the preferred order, then search for a match
            if (dict) {
                var prefixes = preferedOrderPrefixes(localNamespaces, globalNamespaces, tns);
                let prefixesLen = prefixes.length;
                for (var i = 0; i < prefixesLen; i++) {
                    var tryName = name;
                    if (kind !== 'wsdl') {
                        tryName += '_' + kind;
                    }
                    if (prefixes[i].length > 0) {
                        tryName += '_' + prefixes[i];
                    }
                    let search = dict.dictEntry;
                    if (search && search[tryName]) {
                        nsName = tryName; // Found a match
                        break;
                    }
                }
            } else {
                if (tns) {
                    nsName = resolveNsName(name, kind, tns, globalNamespaces);
                }
            }
        }
    }
    return nsName;
}

/**
* Return true if built-in xsd type
*/
function isXSDType(type, namespaces, namespaces2) {
    var ret = false;
    var index, prefix;
    var xsdPrefixes = getXSDPrefixes(namespaces);
    if (xsdPrefixes.length > 0 && type) {
        index = type.indexOf(':');
        if (index != -1) {
            prefix = type.substring(0, index);
            if (xsdPrefixes.indexOf(prefix) != -1) {
                ret = true;
            }
        } else if (getXSDMapping(type)) {
            ret = true;
        }
    }
    if (namespaces2 && !ret) {
        xsdPrefixes = getXSDPrefixes(namespaces2);
        if (xsdPrefixes.length > 0 && type) {
            index = type.indexOf(':');
            if (index != -1) {
                prefix = type.substring(0, index);
                if (xsdPrefixes.indexOf(prefix) != -1) {
                    ret = true;
                }
            }
        }
    }
    return ret;
}

/**
* Return true if xsd:isAnyType
*/
function isXSDAnyType(type, namespaces, namespaces2) {
    if (isXSDType(type, namespaces, namespaces2)) {
        var shortName = type;
        var index = type.indexOf(':');
        if (index != -1) {
            shortName = type.substring(index + 1);
        }
        return (shortName === 'anyType');
    }
    return false;
}

/**
* Returns the best match NSName
*/
function bestMatch(name, kind, schema, dict, namespaces) {
    var ret = name;
    checkKind(kind);
    if (kind !== 'wsdl') {
        ret += '_' + kind;
    }
    let req = dict ? dict.req : null;
    if (name && schema && dict && dict.dictEntry) {
        let nsName = resolveNameInNamespace(name, kind, schema.xmlns, namespaces, schema.tns, dict);
        if (kind === 'attributeGroup') {
            if (!dict.dictEntry[nsName]) {
                R.error(req, g.http(u.r(req)).f('The attributeGroup ref %s could not be found.', nsName));
                return ret;
            }
            return nsName;
        }
        if (!dict.dictEntry[nsName]) {
            // For historical reasons the namespace is stripped for context specific fallback processing.
            nsName = u.stripNamespace(name);

            // Failed to find this name in the all of the schema that was processed.
            // If not a built-in name then annotate the swagger.
            if (!getXSDMapping(nsName)) {
                if (!isXSDType(name, namespaces, schema.xmlns)) {
                    R.error(req, g.http(u.r(req)).f('Could not resolve reference %s.', name));
                } else if (nsName && nsName.length > 0) {
                    R.error(req, g.http(u.r(req)).f('Mapping \'xsd\' specification \'type\' %s to \'string\'.', name));
                }
            }
        }
        if (nsName) {
            ret = nsName;
        }
    }
    return ret;
}


/**
 * Prefered Order of prefixes when sorting for a defaultNamespace
 */
function preferedOrderPrefixes(localNamespaces, globalNamespaces, tns) {
    var prefixes = [ '' ];
    var prefix;
    // First add the special ns* prefixes that are added by the npm soap Utility
    var i = 1;
    prefix = 'ns' + i;
    while ((globalNamespaces && globalNamespaces[prefix]) || (localNamespaces && localNamespaces[prefix])) {
        prefixes.push(prefix);
        i++;
        prefix = 'ns' + i;
    }
    // Now try tns
    if (tns) {
        prefix = u.getPrefixForNamespace(tns, localNamespaces);
        if (prefix) {
            prefixes.push(prefix);
        }
        prefix = u.getPrefixForNamespace(tns, globalNamespaces);
        if (prefix) {
            prefixes.push(prefix);
        }
    }
    // Now add the local prefixes
    for (prefix in localNamespaces) {
        prefixes.push(prefix);
    }

    // Now add the global prefixes
    for (prefix in globalNamespaces) {
        prefixes.push(prefix);
    }
    return prefixes;
}

/**
* Return the xso mapping for built-xsd names
*/
function getXSDMapping(shortName) {
    var XSD_MAPPING = {
        int: {
            type: 'integer',
            format: 'int32'
        },
        unsignedInt: {
            type: 'integer',
            format: 'int64',
            minimum: 0,
            maximum: 4294967295
        },
        unsignedShort: {
            type: 'integer',
            format: 'int32',
            minimum: 0,
            maximum: 65535
        },
        unsignedByte: {
            type: 'integer',
            format: 'int32',
            minimum: 0,
            maximum: 255
        },
        long: {
            type: 'integer',
            format: 'int64'
        },
        unsignedLong: {
            type: 'number',
            minimum: 0
        },
        short: {
            type: 'integer',
            format: 'int32',
            minimum: -32768,
            maximum: 32767
        },
        integer: {
            type: 'number'
        },
        decimal: {
            type: 'number'
        },
        negativeInteger: {
            type: 'number',
            maximum: -1
        },
        nonNegativeInteger: {
            type: 'number',
            minimum: 0
        },
        nonPositiveInteger: {
            type: 'number',
            maximum: 0
        },
        positiveInteger: {
            type: 'number',
            minimum: 1
        },
        float: {
            type: 'number',
            format: 'float'
        },
        double: {
            type: 'number',
            format: 'double'
        },
        string: {
            type: 'string'
        },
        byte: {
            type: 'string',
            format: 'byte'
        },
        binary: {
            type: 'string',
            format: 'binary'
        },
        boolean: {
            type: 'boolean'
        },
        anyType: {
            'x-anyType': true, // Note that no type is provided
        },
        date: {
            type: 'string',
            format: 'date'
        },
        dateTime: {
            type: 'string',
            format: 'date-time'
        },
        anyURI: {
            type: 'string',
            description: 'anyURI'
        },
        anySimpleType: {
            type: 'string'
        },
        NOTATION: {
            type: 'string'
        },
        QName: {
            type: 'string'
        },
        base64Binary: {
            type: 'string',
            format: 'binary'
        },
        hexBinary: {
            type: 'string',
            description: 'base64Binary'
        }, // Don't know what to do for format
        time: {
            type: 'string'
        },
        duration: {
            type: 'string'
        },
        gYearMonth: {
            type: 'string'
        },
        gYear: {
            type: 'string'
        },
        gDay: {
            type: 'string'
        },
        gMonth: {
            type: 'string'
        },
        gMonthDay: {
            type: 'string'
        },
        NCName: {
            type: 'string'
        },
        ID: {
            type: 'string'
        },
        normalizedString: {
            type: 'string'
        },
        token: {
            type: 'string'
        },
        language: {
            type: 'string'
        },
        NMTOKEN: {
            type: 'string'
        },
        NMTOKENS: {
            type: 'string'
        },
        deviationControl: {
            type: 'string'
        },
        simpleDeviationSet: {
            type: 'string'
        },
        Name: {
            type: 'string'
        },
        IDREF: {
            type: 'string'
        },
        IDREFS: {
            type: 'string'
        },
        ENTITY: {
            type: 'string'
        },
        ENTITIES: {
            type: 'string'
        }
    };

    return XSD_MAPPING[shortName];
}

// checks the given name and generates a new one if it conflicts with an existing schema
function makeUniqueNSName(name, dict) {
    var ret = name;
    if (name && dict && dict.dictEntry && dict.dictEntry[name]) {
        var index = 1;
        ret = name + '_' + index;
        while (dict.dictEntry[ret]) {
            index += 1;
            ret = name + '_' + index;
        } // end while
    }
    return ret;
}

/**
* There is a limit on the number of calls to certain functions.
* Without a hard limit, we can have an algorithm overrun leading to CPU or MEM problems
*/
function complexityLimitCheck(dict) {
    if (dict) {
        dict.complexityCount++;
        if (dict.complexityCount > 1000000) {
            throw g.http(u.r(dict.req)).Error('This wsdl is too large to be processed.');
        }
    }
}

exports.annotateError = annotateError;
exports.annotateInfo = annotateInfo;
exports.annotateWarning = annotateWarning;
exports.buildDictionary = buildDictionary;
exports.getXSDMapping = getXSDMapping;
exports.isXSDType = isXSDType;
exports.makeUniqueNSName = makeUniqueNSName;
exports.resolveNameInNamespace = resolveNameInNamespace;
exports.bestMatch = bestMatch;
exports.complexityLimitCheck = complexityLimitCheck;
exports.resolveNsName = resolveNsName;
