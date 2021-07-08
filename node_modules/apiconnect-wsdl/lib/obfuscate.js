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
const d = require('../lib/domUtils.js');
const fileUtils = require('../lib/fileUtils.js');
const parse = require('../lib/parse.js');

const q = require('q');
const yauzl = require('yauzl');
const xmldom = require('xmldom');
const JSZip = require('jszip');
// var g = require('strong-globalize')();
const g = require('../lib/strong-globalize-fake.js');
const fs = require('fs');
var _ = require('lodash');
const jsyaml = require('js-yaml');

var baseNS = initBaseNS();

function initBaseNS() {
    let obj = {};
    let knownNS = d.getKnownNamespaces();
    for (let i = 0; i < knownNS.length; i++) {
        obj[knownNS[i]] = knownNS[i];
    }
    return obj;
}

// This is the map of names (keys) to obfuscated names (values) for the various contexts
// (prefix, namespaces, names, values, files, dirs, documentation)
var map = {
    prefix: {
        xml: 'xml',
        tns: 'tns'
    },
    ns: {
        '##any': '##other',
        '##other': '##other',
        '##local': '##local',
        '##targetNamespace': '##targetNamespace',
    },
    name: {},
    value: {},
    file: {},
    dir: {},
    documentation: {},
    unique: {}
};

_.extend(map.ns, baseNS);

// Prefix to namespace map
let DEFAULT_NS_MAP = {
    xml: 'http://www.w3.org/XML/1998/namespace'
};
let nsMap = u.deepClone(DEFAULT_NS_MAP);

/**
* Obfuscate input zip producing output zip
@param inZip location of input zip file
@param outZip location of output obfuscated zip file
@param outMap location of map of names to obfuscated names
@param inMap optional, location of map of names to new names.
@return promise done
*/
async function obfuscate(inZip, outZip, outMap, inMap, options) {
    options = options || {};
    let req = options.req;
    if (inMap) {
        map = jsyaml.safeLoad(fs.readFileSync(inMap));
    }
    let inContent = fs.readFileSync(inZip);
    if (fileUtils.isZip(inContent)) {
        let data = await obfuscateContent(inContent, options);
        let sanitizedContent = await parse.sanitize(data.archive.content, req);
        fs.writeFileSync(outZip, sanitizedContent);
        fs.writeFileSync(outMap, jsyaml.dump(map));
    } else {
        throw g.http(u.r(req)).Error('Input is not a zip file %s', inZip);
    }
}

/**
* De-Obfuscate input zip producing output zip
@param inZip location of input obfuscated zip file
@param inMap location of map of names to new names.
@param outMap location of map of names to obfuscated names
@param outZip location of output names
*/
function deobfuscate(inZip, inMap, outZip, outMap, options) {
    // Reverse the map (keys->values) become (values->keys)
    // Use the obfuscate method which will deobfuscate with the reversed map
    map = reverseMap(jsyaml.safeLoad(fs.readFileSync(inMap)));
    return obfuscate(inZip, outZip, outMap, null, options);
}

/**
* De-Obfuscate input API
@param inAPI input swagger
@param inMap map of names to new names.
@return de-obfuscated api object
*/
function deobfuscateAPI(inAPI, inMap) {
    let outString = jsyaml.dump(inAPI);
    let useMap = reverseMap(inMap);
    for (let m in useMap) {
        if (m !== 'unique') {
            for (let key in useMap[m]) {
                let value = useMap[m][key];
                if (key !== value) {
                    let regexp = new RegExp(key, 'g');
                    try {
                        outString = replace(outString, regexp, value, m);
                    } catch (e) {
                        let msg = e.toString().substring(0, 500);
                        throw new Error('Safe Load Error after applying ' + regexp + ' --> ' +  value + ' ' + msg);
                    }
                }
            }
        }
    }
    outString = _.replace(outString, /x\-ibm\-name\:.+/g, function(s) {
        let words = _.split(s, ':');

        // Apply slugify
        let ibmName = u.slugifyName(words[1]);
        return 'x-ibm-name: ' + ibmName;
    });
    return jsyaml.safeLoad(outString);
}

/**
* Reverse map, (key->value) becomes (value->key)
*/
function reverseMap(sourceMap) {
    let targetMap = {};
    for (let m in sourceMap) {
        let s = sourceMap[m];
        targetMap[m] = {};
        for (let key in s) {
            let value = s[key];
            targetMap[m][value] = key.toString();
        }
    }
    return targetMap;
}

/**
* Obfuscate zip content
*/
async function obfuscateContent(inContent, options) {
    options = options || {};
    let req = options.req;
    let out = await fileUtils.asContent(inContent, inContent, null, null, req);
    if (!fileUtils.isZip(out.content)) {
        throw new g.http(u.r(req)).Error('Input is not a zip file.');
    }

    let archive = await fileUtils.asRawArchive(out.content, req);
    let data = await fileUtils.pipeArchive(archive, req, null, obfuscateFile);
    return data;
}

/**
* Process the file
* @param fileName
* @param fileContent (this is a String with the decoded content)
* @return { fileName: <obfuscated name> , content <obfuscated decoded content>}
*/
function obfuscateFile(fileName, fileContent, req) {
    try {
        // The nsMap spans a single file, so it must be reset.
        nsMap = u.deepClone(DEFAULT_NS_MAP);

        // Prepare the file, fixing some known xml problems
        fileContent = d.protectDocumentation(fileContent);

        // Load the DOM, files that cannot be loaded will not be included
        // in the output zip.
        let wsdlDoc = d.loadSafeDOM(fileContent, req, fileName);
        if (wsdlDoc) {
            d.removeDTD(wsdlDoc);
            // Files that describe base namespaces are not obfuscated, except
            // for the imports and includes.
            if (shouldObfuscate(fileContent)) {
                obfuscateDOM(wsdlDoc);
                let serializer = new xmldom.XMLSerializer();
                fileContent = serializer.serializeToString(wsdlDoc);
                fileContent = obfuscateWords(fileContent);
            } else {
                // Only obfuscate imports and includes
                let serializer = new xmldom.XMLSerializer();
                fileContent = serializer.serializeToString(wsdlDoc);
                fileContent = obfuscateImportInclude(fileContent);
            }
            // Check the DOM again looking for weird nodes and attributes.
            // If found, an error is thrown to stop the processing.
            let outputDoc = d.loadSafeDOM(fileContent, req, fileName);
            let map = d.getNamesMap(outputDoc);
            checkMap(map, fileName);
            let rc = {
                fileName: obfuscatePath(fileName),
                content: fileContent
            };
            return rc;
        }
    } catch (e) {
        console.log(e);
        throw e;
    }
}


/**
* @return true if file does not define a special, base namespace.
*/
function shouldObfuscate(contents) {
    let obfuscate = true;
    // If this is a targetNamespace for a base namespace, then no need to obfuscate.
    contents = _.replace(contents, / targetNamespace=\"[^\"]*\"/, function(s) {
        let namespace = _.split(s, '\"')[1];
        if (baseNS[namespace]) {
            obfuscate = false;
        }
        return s;
    });
    return obfuscate;
}

/*
* @param path - input path
* @return path with obfuscated directory and filenames
*/
function obfuscatePath(path) {
    let oPath = '';
    let words = _.split(path, /[\\/]/);
    for (let i = 0; i < words.length; i++) {
        let word = words[i];
        let isLast = (i == (words.length - 1));
        if (word === '.' ||
            word === '' ||
            word === '..') {
            oPath += word;
        } else if (isLast) {
            let name;
            if (word.endsWith('.wsdl')) {
                name = word.substring(0, word.length - 5);
                oPath += newWord(name, 'FILE') + '.wsdl';
            } else if (word.endsWith('.xsd')) {
                name = word.substring(0, word.length - 4);
                oPath += newWord(name, 'FILE') + '.xsd';
            } else {
                oPath += newWord(name, 'FILE');
            }
        } else {
            oPath += newWord(word, 'DIR');
        }
        if (!isLast) {
            oPath += '/';
        }
    }
    return oPath;
}

/*
* Obfuscate words in file
* @param contents - String content of the file
* @return obfuscated contents
*/
function obfuscateWords(contents) {
    let defaultNS;
    if (contents) {
        if (contents.toString) {
            contents = contents.toString();
        }
        // Convert prefix/namespace definitions first to set the preferred prefixes
        // A prefix is preferred (not obfuscated), if it is for a special, base namespace.
        contents = _.replace(contents, / xmlns\S*=\"[^\"]*\"/g, function(s) {
            let t;
            let words = _.split(s, '=');
            let namespace = _.split(s, '\"')[1];
            let newNamespace = newWord(namespace, 'NAMESPACE');
            if (words[0].includes(':')) {
                let prefix = words[0].substring(7);
                let newPrefix = prefix;
                nsMap[prefix] = namespace;
                if (map.ns[namespace]  === namespace) {
                    map.prefix[prefix] = prefix;
                } else {
                    newPrefix = newWord(prefix, 'PREFIX');
                }
                t = ' xmlns:' + newPrefix + '=\"' + newNamespace + '\"';
            } else {
                t = ' xmlns=\"' + newNamespace + '\"';
                defaultNS = newNamespace;
            }
            return t;
        });

        // Convert name, part, parts, parameterOrder to use obfuscated names
        contents = _.replace(contents, / name=\"[^\"]*\"/g, function(s) {
            let name = _.split(s, '\"')[1];
            let newName = newWord(name, 'NAME');
            return ' name=\"' + newName + '\"';
        });
        contents = _.replace(contents, / part=\"[^\"]*\"/g, function(s) {
            let part = _.split(s, '\"')[1];
            let newPart = newWord(part, 'NAME');
            return ' part=\"' + newPart + '\"';
        });
        contents = _.replace(contents, / parts=\"[^\"]*\"/g, function(s) {
            let parts = _.split(_.split(s, '\"')[1], ' ');
            let t = ' parts=\"';
            for (let i = 0; i < parts.length; i++) {
                let part = parts[i].trim();
                if (part) {
                    if (i > 0) {
                        t += ' ';
                    }
                    t += newWord(part, 'NAME');
                }
            }
            t += '\"';
            return t;
        });
        contents = _.replace(contents, / parameterOrder=\"[^\"]*\"/g, function(s) {
            let parameterOrder = _.split(_.split(s, '\"')[1], ' ');
            let t = ' parameterOrder=\"';
            for (let i = 0; i < parameterOrder.length; i++) {
                let part = parameterOrder[i].trim();
                if (part) {
                    if (i > 0) {
                        t += ' ';
                    }
                    t += newWord(part, 'NAME');
                }
            }
            t += '\"';
            return t;
        });

        // Assess/Remove fixed and default fields
        const ALLOW_VALUE = [ '0', '1', '2', 'true', 'false' ];
        contents = _.replace(contents, / fixed=\"[^\"]*\"/g, function(s) {
            let name = _.split(s, '\"')[1];
            return ALLOW_VALUE.indexOf(name) < 0 ? '' : ' fixed=' + s;
        });
        contents = _.replace(contents, / default=\"[^\"]*\"/g, function(s) {
            let name = _.split(s, '\"')[1];
            return ALLOW_VALUE.indexOf(name) < 0 ? '' : ' default=' + s;
        });

        // Convert type, base and other references
        let refList = [ 'type', 'ref', 'base', 'element', 'attribute', 'substitutionGroup', 'attributeGroup', 'group', 'message', 'binding', 'itemType' ];
        for (let i = 0; i < refList.length; i++) {
            let ref = refList[i];
            let regexp = new RegExp(' ' + ref + '=\"\[^\"]*\"', 'g');
            contents = _.replace(contents, regexp, function(s) {
                let words = _.split(s, /[\":]/);
                let t = s;
                if (words.length === 3) {
                    // Uncommon.  This is a use of a default namespace (ie. no prefix)
                    // This is a bit hacky.
                    if (!defaultNS || map.ns[defaultNS] !== defaultNS) {
                        let name = words[1];
                        let newName = newWord(name, 'NAME');
                        t = ' ' + ref + '=\"' + newName + '\"';
                    }
                } else if (words.length === 4) {
                    let name = words[2];
                    let prefix = words[1];
                    let newPrefix = newWord(prefix, 'PREFIX');
                    if (nsMap[prefix] && map.ns[nsMap[prefix]] === nsMap[prefix]) {
                        // reference is to a special namespace, don't obfuscate the name
                        t = ' ' + ref + '=\"' + newPrefix + ':' + name + '\"';
                    } else {
                        let newName = newWord(name, 'NAME');
                        t = ' ' + ref + '=\"' + newPrefix + ':' + newName + '\"';
                    }
                }
                return t;
            });
        }
        // Convert the references within memberTypes
        let regexp = new RegExp(' memberTypes=\"\[^\"]*\"', 'g');
        contents = _.replace(contents, regexp, function(s) {
            let mt = _.split(s, '=')[1];
            let qnames = _.split(mt, /[ \"]/);
            let t = ' memberTypes=\"';
            for (let i = 1; i < qnames.length - 1; i++) {
                let qname = qnames[i].trim();
                if (qname) {
                    if (i > 1) {
                        t += ' ';
                    }
                    if (qname.indexOf(':') >= 0) {
                        let prefix = _.split(qname, ':')[0];
                        let name = _.split(qname, ':')[1];
                        let newPrefix = newWord(prefix, 'PREFIX');
                        if (nsMap[prefix] && map.ns[nsMap[prefix]] === nsMap[prefix]) {
                            // reference is to a special namespace, don't obfuscate the name
                            t += newPrefix + ':' + name;
                        } else {
                            let newName = newWord(name, 'NAME');
                            t += newPrefix + ':' + newName;
                        }
                    } else {
                        let newName = newWord(qname, 'NAME');
                        t += newName;
                    }
                }
            }
            t += '\"';
            return t;
        });
        // Remove ids, source, xpath, refer...not needed
        contents = _.replace(contents, / id=\"[^\"]*\"/g, function(s) {
            return '';
        });
        contents = _.replace(contents, / source=\"[^\"]*\"/g, function(s) {
            return '';
        });
        contents = _.replace(contents, / xpath=\"[^\"]*\"/g, function(s) {
            return '';
        });
        contents = _.replace(contents, / refer=\"[^\"]*\"/g, function(s) {
            return '';
        });

        // Obfuscate the references to namespaces (targetNamespace,
        // various location attributes, namespace, soapAction, etc)
        contents = _.replace(contents, / targetNamespace=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' targetNamespace=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        // http operation location
        contents = _.replace(contents, /operation location=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = 'operation location=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        // http and soap address location
        contents = _.replace(contents, /address location=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = 'address location=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, / namespace=\"[^\"]*\"/g, function(s) {
            let namespaces = _.split(_.split(s, '\"')[1], ' ');
            let t = ' namespace=\"';
            for (let i = 0; i < namespaces.length; i++) {
                let ns = namespaces[i].trim();
                if (ns) {
                    if (i > 0) {
                        t += ' ';
                    }
                    t += newWord(ns, 'NAMESPACE');
                }
            }
            t += '\"';
            return t;
        });
        contents = _.replace(contents, / soapAction=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' soapAction=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, / Action=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' Action=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, /:Action=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ':Action=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, / public=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' public=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, / system=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' system=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, / URI=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' URI=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });
        contents = _.replace(contents, / system=\"[^\"]*\"/g, function(s) {
            let namespace = _.split(s, '\"')[1];
            let t = ' system=\"' + newWord(namespace, 'NAMESPACE') + '\"';
            return t;
        });

        // obfuscate the paths in the imports/includes
        contents = obfuscateImportInclude(contents);

        // obfuscate any other values (for enumerations values, version, etc.)
        contents = _.replace(contents, / Id=\"[^\"]*\"/g, function(s) {
            let policyID = _.split(s, '\"')[1];
            let t = ' Id=\"' + newWord(policyID, 'VALUE') + '\"';
            return t;
        });
        contents = _.replace(contents, / version=\"\.+\"/g, function(s, offset) {
            if (offset < 7) {
                // Probably part of xml directive
                return s;
            }
            let value = _.split(s, '\"')[1];
            let t = ' version=\"' + newWord(value, 'VALUE') + '\"';
            return t;
        });
    }
    return contents;
}

/*
* Obfuscate import/include paths in file.
* @param contents - String content of the file
* @return obfuscated contents
*/
function obfuscateImportInclude(contents) {
    // wsdl import location
    contents = _.replace(contents, /import[^>]*? location=\"[^\"]*\"/g, function(s) {
        let sub = s.substring(s.indexOf('location='));
        let location = _.split(sub, '\"')[1];
        let newPath = obfuscatePath(location);
        let t = _.replace(s, location, newPath);
        return t;
    });
    // schemaLocation
    contents = _.replace(contents, / schemaLocation=\"[^\"]*\"/g, function(s) {
        let location = _.split(s, '\"')[1];
        let newPath = obfuscatePath(location);
        let t = ' schemaLocation=\"' + newPath + '\"';
        return t;
    });
    return contents;
}


/*
* Obfuscate DOM
* @param DOM content of file or partial DOM
* @return DOM with obfuscated contents
*/
function obfuscateDOM(dom) {
    d.traverseDOM(dom, function(node) {
        if (node.nodeName) {
            if (node.nodeName === '#text') {
                // If not whitespace, then obfuscate the text
                let data = node.data.trim();
                if (data) {
                    node.data = newWord(node.data, 'DOCUMENTATION');
                }
            } else if (node.nodeName === '#comment' ||
                       node.nodeName === 'appinfo' ||
                       node.nodeName.endsWith(':appinfo')) {
                // Comments are not needed
                // appinfo is not needed
                node.parentNode.removeChild(node);
                node = null;
            } else if (node.nodeName === 'pattern' ||
                       node.nodeName.endsWith(':pattern')) {
                // patterns are not needed
                node.parentNode.removeChild(node);
                node = null;
            } else if (node.nodeName === 'enumeration' ||
                       node.nodeName.endsWith(':enumeration')) {
                // enumerations are not needed
                node.parentNode.removeChild(node);
                node = null;
            } else if (node.nodeName === 'documentation' ||
                       node.nodeName.endsWith(':documentation')) {
                // obfuscate the documentation
                obfuscateDocumentation(node);
                node = null;  // no need to traverse deeper
            }
        }
        return node;
    });
}

/**
* @param documentation node
* @param documentation node wih obfuscated contents
*/
function obfuscateDocumentation(documentation) {
    let removeNodes = [];
    let nodes = documentation.childNodes;
    for (let i = 0; i < nodes.length; i++) {
        let child = nodes[i];
        if (child.nodeName === '#text' || child.nodeName === '#cdata-section') {
            child.data = newWord(child.data, 'DOCUMENTATION');
        } else {
            removeNodes.push(child);
        }
    }
    for (let i = 0; i < removeNodes.length; i++) {
        removeNodes[i].parentNode.removeChild(removeNodes[i]);
    }
}

/*
* Creates a new word and stores it in the map
* @param source word
* @param context of the word
* @returned word
*/
function newWord(source, context) {
    // Determine if we want a new word
    if (!source || source.trim().length === 0) {
        return source;
    }
    if (source.trim().toLowerCase() === 'true' ||
        source.trim().toLowerCase() === 'false' ||
        source.trim().toLowerCase() === 'null' ||
        !Number.isNaN(Number(source.trim().toLowerCase()))) {
        return source;
    }

    let target;
    if (context === 'NAME') {
        target = map.name[source];
        if (!target) {
            target = uniqueName(source);
            map.name[source] = target;
        }
    } else if (context === 'PREFIX') {
        target = map.prefix[source];
        if (!target) {
            if (source.startsWith('ns')) {
                // There is some 'specialness' around ns prefixes being preferred
                // in some cases.
                target = source;
            } else {
                target = uniqueWord('a', 4);
                map.prefix[source] = target;
            }
        }
    } else if (context === 'NAMESPACE') {
        target = map.ns[source];
        if (!target) {
            target = uniqueWord('url', 6);
            // Some decisions are based on whether the namespace is on the localhost
            if (source.indexOf('localhost') !== -1) {
                target += '/localhost:9080/';
            }
            map.ns[source] = target;
        }
    } else if (context === 'VALUE') {
        target = map.value[source];
        if (!target) {
            target = uniqueWord('v', 6);
            map.value[source] = target;
        }
    } else if (context === 'FILE') {
        target = map.file[source];
        if (!target) {
            target = uniqueWord('f', 5);
            map.file[source] = target;
        }
    } else if (context === 'DIR') {
        target = map.dir[source];
        if (!target) {
            target = uniqueWord('dir', 7);
            map.dir[source] = target;
        }
    } else if (context === 'DOCUMENTATION') {
        target = map.documentation[source];
        if (!target) {
            target = uniqueWord('d', 6);
            map.documentation[source] = target;
        }
    }
    return target;
}

/**
* @param source name
* @return new name
*/
function uniqueName(source) {
    let match = false;
    // Preserve common suffixes (not greedy)
    let t = _.replace(source, /^(.*?)(Type|Element|Port|PortType|Message|Operation|Service|Services|ServicePort|ServiceBinding|Binding|Input|Output|Fault|Attribute|Group|AttributeGroup)$/, function(s, p1, p2) {
        match = true;
        if (p1) {
            let n = map.name[p1];
            if (!n) {
                n = uniqueWord('n', 8);
                map.name[p1] = n;
            }
            return n + (p2 || '');
        }
        return s;
    });
    if (!match) {
        t = uniqueWord('n', 8);
    }
    return t;
}

/**
* Create a new unique word of the required size.
* @param prefix of word
* @param lenght of words
* @return new word
*/
function uniqueWord(prefix, length) {
    let limit = Math.pow(10, (length - prefix.length));
    let rand = _.random(0, limit, false);
    let unique = prefix + rand;
    while (map.unique[unique] || unique.length != length) {
        rand = _.random(0, limit, false);
        unique = prefix + rand;
    }
    map.unique[unique] = unique;
    return unique;
}


/**
* Smart replace of yaml source
* @param source as string
* @param regexp describing text to change
* @param value  new text
* @param key describing the context map
*/
function replace(source, regexp, value, key) {
    let outString = _.replace(source, regexp, value);
    // Quick return if no replacement occurred
    if (_.isEqual(source, outString)) {
        return outString;
    }

    // Make sure the new text can be loaded, if not then adjust
    // (This is an expensive yaml load)
    let e = checkLoad(outString);
    if (e) {
        if (key === 'value') {
            let tryValue = JSON.stringify(value);
            outString = _.replace(source, regexp, tryValue);
            e = checkLoad(outString);
        } else if (key === 'documentation') {
            // First try doing a simple escape
            let tryValue = escapeYAML(value);
            outString = _.replace(source, regexp, tryValue);
            e = checkLoad(outString);
        }
    }
    if (e) {
        if (key === 'documentation') {
            // Second try is to quote
            let tryValue = '"' + escapeYAML(value) + '"';
            outString = _.replace(source, regexp, tryValue);
            e = checkLoad(outString);
        }
    }
    if (e) {
        if (key === 'documentation') {
            // Third try is do a JSON.stringify
            let tryValue = JSON.stringify(value);
            outString = _.replace(source, regexp, tryValue);
            e = checkLoad(outString);
        }
    }
    if (e) {
        throw e;
    }
    return outString;
}

/**
* @return true if content can be loaded
*/
function checkLoad(content) {
    try {
        jsyaml.safeLoad(content);
    } catch (e) {
        return e;
    }
    return null;
}

/**
* Escape yaml text
*/
function escapeYAML(text) {
    var map = { '\'': '\'\'' };
    function chr2enc(a) {
        return map[a];
    }
    return text.replace(/[\']/g, chr2enc);
}

/**
* Check the map from getNames to discover problems
* @param map
* @param fileName file that is being checked.
*/
function checkMap(map, fileName) {

    let errNodes = [];
    let errAttrs = [];
    for (let key in map.nodes) {
        if (!d.getNameInfo(key).known) {
            errNodes.push(key);
        }
    }
    for (let key in map.attrs) {
        if (!d.getAttrInfo(key).known) {
            errAttrs.push(key);
        }
    }

    if (errNodes.length > 0 || errAttrs.length > 0) {
        throw new Error('Found suspicious nodes [' + errNodes + '] and attributes [' + errAttrs + '] in ' + fileName);
    }
}


exports.obfuscate = obfuscate;
exports.deobfuscate = deobfuscate;
exports.deobfuscateAPI = deobfuscateAPI;
