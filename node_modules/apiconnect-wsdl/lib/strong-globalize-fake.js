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

// apiconnect-wsdl is not ready for strong-globalize
// But we may need it in the future, so the code uses apis that mimic strong-globalize
// To support strong-globalize, remove this file an change the requires that reference this files

var g = {
    f: function() {
        let ret = '';
        if (arguments.length > 0) {
            ret = arguments[0];
            for (let i = 1; i < arguments.length; i++) {
                ret = ret.replace('%s', arguments[i]);
            }
        }
        return ret;
    },
    Error: function() {
        let msg = this.f(...arguments);
        return new Error(msg);
    }
};

function http(obj) {
    return g;
}

exports.http = http;
