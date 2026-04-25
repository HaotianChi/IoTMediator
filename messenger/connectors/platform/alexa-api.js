'use strict';
// -*- coding: utf-8 -*-


let db = require('../core/db');
const config = require('../../config/default');
const utility = require('../core/utility.js');
const deviceConnector= require('../connectors/device/device-connector');
const cloudDeviceConnector = require('../connectors/device/cloud-device-connector');
const request = require('request');
const {v4: uuid} = require('uuid');

const platform = 'alexa';

function reportDeviceEventToAlexaEventGateway(event) {
    console.log("pushed an event:", event.device.uid, event.attribute, event.value);//
    db.getPToken('alexa').then(tokenRow => {
        let event_res = new AlexaResponse({"name": "ChangeReport"});
        event_res.event.endpoint.scope.token = tokenRow.access_token;
        event_res.event.endpoint.endpointId = event.device.uid;
        let capability = convertAttributeToCapability(event.attribute);
        event_res.event.payload.change = {
            properties: [{
                namespace: capability,
                name: capability_supported_properties[capability][0],
                value: SanitizeValue(capability, capability_supported_properties[capability][0], event.value),
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: event.uncertaintyInMilliseconds ? event.uncertaintyInMilliseconds : 0
            }]
        }

        if (config.verbose) console.debug(JSON.stringify(event_res));

        sendPostRequest(config.alexa.event_endpoint_url, event_res, tokenRow.access_token, (err, res, body) => {
            switch(res.statusCode) {
                case 202:
                    break;
                case 401:
                    request.post(config.alexa.lwa_token_url, 
                        {
                            auth: {
                                user:config.alexa.client_id,
                                password: config.alexa.client_secret
                            },
                            json: {
                                grant_type: 'refresh_token',
                                refresh_token: tokenRow.refresh_token,
                            }
                        }, (err, res1, body1) => {
                        if (err) {
                            return console.error("#### Error during token refreshing:", err);
                        }
                        if (config.verbose) console.debug("statusCode during token refreshing:", res1.statusCode);
                        if(res1.statusCode === 200) {
                            let token = {};
                            token.platform = platform;
                            token.client_id = config.alexa.client_id;
                            token.access_token = body1.access_token;
                            token.refresh_token = body1.refresh_token;
                            token.expires_in = body1.expires_in;
                            db.updatePToken(token).then(() => {
                                sendPostRequest(config.alexa.event_endpoint_url, event_res, token.access_token, (err, res, body) => {
                                    if(err) {
                                        return console.error("#### Error while reporting change event with new token:", err);
                                    }
                                    
                                    if(res.statusCode === 202) {
                                        return;
                                    } else {
                                        console.error("#### Error while reporting change event with new token, statusCode:", res.statusCode);
                                    }
                                })
                            }).catch(err => {
                                return console.error("#### Error: ", err.message);
                            });
                        } else {
                            return console.error("#### Error during token refreshing, statusCode:", res1.statusCode);
                        }

                    });  
                    break;
                default:
                    console.error("#### Unhandled response error with statusCode:", res.statusCode);
                    break;
            }
        });
        return;
    });
}

function sendPostRequest(url, data, token, callback) {
    let options = {
        method: 'POST',
        body: data,
        json: true,
        url: url,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        }
    }
    request.post(options, (err, res, body) => {
        if (err) {
            return console.error(err);
        }
        callback(err, res, body);
    });  
}

module.exports = {
    reportDeviceEventToAlexaEventGateway: reportDeviceEventToAlexaEventGateway,
}



/**
 * Helper class to generate an AlexaResponse.
 * @class
 */
class AlexaResponse {

    /**
     * Check a value for validity or return a default.
     * @param value The value being checked
     * @param defaultValue A default value if the passed value is not valid
     * @returns {*} The passed value if valid otherwise the default value.
     */
    checkValue(value, defaultValue) {

        if (value === undefined || value === {} || value === "")
            return defaultValue;

        return value;
    }

    /**
     * Constructor for an Alexa Response.
     * @constructor
     * @param opts Contains initialization options for the response
     */
    constructor(opts) {

        if (opts === undefined)
            opts = {};

        if (opts.context !== undefined)
            this.context = this.checkValue(opts.context, undefined);

        if (opts.event !== undefined)
            this.event = this.checkValue(opts.event, undefined);
        else
            this.event = {
            "header": {
                "namespace": this.checkValue(opts.namespace, "Alexa"),
                "name": this.checkValue(opts.name, "Response"),
                "messageId": this.checkValue(opts.messageId, uuid()),
                // "correlationToken": this.checkValue(opts.correlationToken, undefined),
                "payloadVersion": this.checkValue(opts.payloadVersion, "3")
            },
            "endpoint": {
                "scope": {
                    "type": "BearerToken",
                    "token": this.checkValue(opts.token, "INVALID"),
                },
                "endpointId": this.checkValue(opts.endpointId, "INVALID")
            },
            "payload": this.checkValue(opts.payload, {})
        };

        // No endpoint in an AcceptGrant or Discover request
        if (this.event.header.name === "AcceptGrant.Response" || this.event.header.name === "Discover.Response")
            delete this.event.endpoint;

    }

    /**
     * Add a property to the context.
     * @param opts Contains options for the property.
     */
    addContextProperty(opts) {

        if (this.context === undefined)
            this.context = {properties: []};

        this.context.properties.push(this.createContextProperty(opts));
    }

    /**
     * Add an endpoint to the payload.
     * @param opts Contains options for the endpoint.
     */
    addPayloadEndpoint(opts) {

        if (this.event.payload.endpoints === undefined)
            this.event.payload.endpoints = [];

        this.event.payload.endpoints.push(this.createPayloadEndpoint(opts));
    }

    /**
     * Creates a property for the context.
     * @param opts Contains options for the property.
     */
    createContextProperty(opts) {
        return {
            'namespace': this.checkValue(opts.namespace, "Alexa.EndpointHealth"),
            'name': this.checkValue(opts.name, "connectivity"),
            'value': this.checkValue(opts.value, {"value": "OK"}),
            'timeOfSample': new Date().toISOString(),
            'uncertaintyInMilliseconds': this.checkValue(opts.uncertaintyInMilliseconds, 0)
        };
    }

    /**
     * Creates an endpoint for the payload.
     * @param opts Contains options for the endpoint.
     */
    createPayloadEndpoint(opts) {

        if (opts === undefined) opts = {};

        // Return the proper structure expected for the endpoint
        let endpoint =
            {
                "capabilities": this.checkValue(opts.capabilities, []),
                "description": this.checkValue(opts.description, "This is a device from MP-Proxy"),
                "displayCategories": this.checkValue(opts.displayCategories, ["OTHER"]),
                "endpointId": this.checkValue(opts.endpointId, 'endpoint-001'),
                // "endpointId": this.checkValue(opts.endpointId, 'endpoint_' + (Math.floor(Math.random() * 90000) + 10000)),
                "friendlyName": this.checkValue(opts.friendlyName, "Sample Endpoint"),
                "manufacturerName": this.checkValue(opts.manufacturerName, "This is an anonymous manufacturer name."),
                "cookie": this.checkValue(opts.cookie, {}),
            };

        // if (opts.hasOwnProperty("cookie"))
        //     endpoint["cookie"] = this.checkValue('cookie', {});

        return endpoint;
    }

    /**
     * Creates a capability for an endpoint within the payload.
     * @param opts Contains options for the endpoint capability.
     */
    createPayloadEndpointCapability(opts) {

        if (opts === undefined) opts = {};

        let capability = {};
        capability['type'] = this.checkValue(opts.type, "AlexaInterface");
        capability['interface'] = this.checkValue(opts.interface, "Alexa");
        capability['version'] = this.checkValue(opts.version, "3");
        let supported = this.checkValue(opts.supported, false);
        if (supported) {
            capability['properties'] = {};
            capability['properties']['supported'] = supported;
            capability['properties']['proactivelyReported'] = this.checkValue(opts.proactivelyReported, true);
            capability['properties']['retrievable'] = this.checkValue(opts.retrievable, true);
        }
        return capability
    }

    /**
     * Get the composed Alexa Response.
     * @returns {AlexaResponse}
     */
    get() {
        return this;
    }
}


const interfaces_with_directives = ['alexa.powercontroller', 'alexa.brightnesscontroller', 'alexa.percentagecontroller', 'alexa.lockcontroller']; // percentagecontroller for backup
const supported_attributes = ['switch', 'level', 'lock', 'temperature', 'contact', 'motion']; // supported attributes by Alexa

const capability_to_attributes = {
    'Alexa.PowerController': ['switch'],
    'Alexa.BrightnessController': ['level'],
    'Alexa.LockController': ['lock'],
    'Alexa.TemperatureSensor': ['temperature'],
    'Alexa.ContactSensor': ['contact'],
    'Alexa.MotionSensor': ['motion'],
}

const capability_supported_properties = {
    'Alexa.PowerController': ['powerState'],
    'Alexa.BrightnessController': ['brightness'],
    'Alexa.LockController': ['lockState'],
    'Alexa.TemperatureSensor': ['temperature'],
    'Alexa.ContactSensor': ['detectionState'],
    'Alexa.MotionSensor': ['detectionState'],
}

function convertCapabilityToAttribute(capability) { // ToDo: rename property to capability
    let attribute;
    if (Object.keys(capability_to_attributes).includes(capability)) {
        if(capability_to_attributes[capability].length === 1) {
            attribute = capability_to_attributes[capability][0];
        } else {
            console.error(`The property ${capability} has more than 1 match, HANDLE it...`);
        }
    } else {
        console.error(`##### The property ${capability} is not recognized!`);
    }
    return attribute;
}

function convertAttributeToCapability(attribute) { // ToDo: rename property to capability
    let capability;
    for(let capa in capability_to_attributes) {
        if(capability_to_attributes[capa].includes(attribute)) {
            capability = capa;
        }
    }
    return capability;
}

function SanitizeValue(capability, property, original_value) {
    let resValue;
    switch(property) {
        case 'powerState':
            resValue = (['ON', 'on'].includes(original_value)) ? 'ON' : 'OFF';
            break;
        case 'brightness':
            resValue = original_value;
            break;
        case 'lockState':
            resValue = (['ON', 'on', 'unlocked'].includes(original_value)) ? 'UNLOCKED' : 'LOCKED';
            break;
        case 'temperature':
            resValue = original_value;
            break;
        case 'detectionState':
            if(capability === 'Alexa.ContactSensor') {
                resValue = (['OPEN', 'open'].includes(original_value)) ? 'DETECTED' : 'NOT_DETECTED';
            } else if(capability === 'Alexa.MotionSensor') {
                resValue = (['ON', 'on', 'active', 'ACTIVE'].includes(original_value)) ? 'DETECTED' : 'NOT_DETECTED';
            }
            break;
        default:
            console.error(`#### Cannot sanitize the value of ${capability}.${property}`);
            break;
    }
    
    return resValue;
}




if (typeof require !== 'undefined' && require.main === module) {
    const event1 = {
        device: {
            uid: 'outlet_id', 
        },
        attribute: 'switch',
        value: 'OFF'
    }

    const event2 = {
        device: {
            uid: 'motion_id', 
        },
        attribute: 'motion',
        value: 'inactive'        
    }
    reportDeviceEventToAlexaEventGateway(event2);
}