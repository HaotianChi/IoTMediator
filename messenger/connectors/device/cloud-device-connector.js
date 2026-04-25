
/*
    This device connector is used to access devices from device vendor cloud APIs;
    Cloud APIs usually do not push device state changes, so we need to call APIs periodically to get newest device states ***without violating the API rate limit***
*/
const db = require('../core/db.js');
const request = require('request');
const config = require('../../config/default');
const https = require('https');
const http = require('http');
const format = require('string-format');

const honeywell = require('./honeywell-api');
const lifx = require('./lifx-api');
//const hue = require('./hue-api');
const hue_local = require('./hue-local-api'); // Prefer local API to avoid cloud API rate limits.
const { getAllDevices } = require('./device-connector.js');

db.open();

const CloudDeviceConnector = {
    requestIntegrateDevices: function() {
        console.log("requesting integrate cloud devices...");

        if(config.cloud_device_connector.honeywell.apikey) {
            honeywell.request_authorize();
        }

        if(config.cloud_device_connector.lifx.bearerToken) {
            lifx.request_authorize();
        }

        // if(config.cloud_device_connector.hue.clientId) {
        //     hue.request_authorize();
        // }
    },

    getAllDevices: function(verbose=false) {
        console.log("getAllDevices is called...");
        return new Promise((resolve, reject) => {
            let allDevices = [];
            //enumerate all device brands

            let promises = [];
            
            if(config.cloud_device_connector.honeywell.apikey !== undefined) {
                let honeywell_temp = db.getPToken('honeywell').then(tokens => {
                    //console.log("get all devices:", tokens);
                    if(tokens instanceof Object) {
                        //console.log("here");
                        //promises.push(honeywell.discoverAllWaterLeakageSensors(tokens));
                        // honeywell.getLocationId(tokens).then(location_id => {
                        //     return honeywell.discoverAllWaterLeakageSensors(location_id, tokens);
                        // })
                        return honeywell.discoverAllWaterLeakageSensors('1935763', tokens);
                    }
                });
                promises.push(honeywell_temp);
            }

            let lifx_temp = lifx.discoverAllLights(); 
            promises.push(lifx_temp);
            
            let hue_lights_temp = hue_local.createHueApi().then(api => {
                return hue_local.discoverAllLights(api);
            })

            promises.push(hue_lights_temp);

            let hue_sensors_temp = hue_local.createHueApi().then(api => {
                return hue_local.discoverAllSensors(api);
            })

            promises.push(hue_sensors_temp);

            //let promises = [honeywell_temp, lifx_temp, hue_lights_temp, hue_sensors_temp];
            Promise.allSettled(promises).then(results => {
                console.log('###################getAllDevices results:', results);
                for (let result of results) {
                    let devices;
                    if(result.status === 'fulfilled') {
                        devices = result.value;
                    }
                    //console.log("result:", devices);
                    if(devices instanceof Array) {
                        for(let device of devices) {
                            if (config.target_platform === 'smartthings' && device.source === 'hue') {
                                if(device.attributes.includes('button_group')) {
                                    continue; // Skip Hue four-button switch for SmartThings compatibility.
                                }
                            }    
                            let allDeviceEach = {};
                            allDeviceEach.uid = device.uid;
                            allDeviceEach.label = device.label;
                            allDeviceEach.thingTypeUID = device.thingTypeUID;
                            allDeviceEach.attributes = device.attributes;
                            allDeviceEach.values = device.values;
                            allDeviceEach.source = device.source;
                            allDevices.push(allDeviceEach);
                        }
                    }

                }
            }).then(() => {
                if(verbose) console.log("All cloud devices:", allDevices);
                resolve(allDevices);
            }).catch(err => {
                console.log("cloud-device-connector getAllDevices:", err);
            });
        });
    },


    getDevice: function(id) {
        return new Promise((resolve, reject) => {
            // this.getAllDevices().then((devices) => {
            //     var found = false;
            //     for(let device of devices) {
            //         if (device.uid === id) {
            //             found = true;
            //             resolve(device);
            //         }
            //     }
            //     resolve();
            // })
            db.getDevice(id).then(device => {
                resolve(device);
            });
        });
    },


    getDeviceState: function(id, attribute) {
        return new Promise((resolve, reject) => {
            // this.getAllDevices().then((devices) => {
            //     var found = false;
            //     for(let device of devices) {
            //         if (device.uid === id) {
            //             for(let attr of device.attributes) {
            //                 if (attr === attribute) {
            //                     resolve(device.values[attribute]);
            //                 }
            //             }
                        
            //         }
            //     }
            //     resolve();
            // });
            db.getState(id, attribute).then((state) => {
                resolve(state);
            });
        });
    },

    isAttributeActuatable: function(attribute) {
        if (config.cloud_device_connector.actuatable_attributes.includes(attribute)) {
            return True;
        }
        else if (config.cloud_device_connector.all_attributes.includes(attribute)) {
            return False
        }
        else {
            console.error('unknown attribute: ', attribute);
        }       
    },


    sendCommandToDevice(id, command) {
        return new Promise((resolve, reject) => {
            db.getDevice(id).then((device) => {
                switch(device.source) {
                    case "honeywell":
                        resolve();
                        break;
                    case "lifx":
                        lifx.controlLight(id, command); // command: ["on", "off"]
                        resolve();
                        break;

                    case "hue":
                        hue_local.createHueApi().then(api => {
                            hue_local.controlLight(api, id, command);
                            resolve();
                        })
                        break;
                    default:
                        console.error("Unhandled cloud device source.");
                }
            }).catch(err => {
                console.log("cloud-device-connector sendCommandToDevice:", err);
            });
        });
    },

    subscribeToEvents(callback) {
        db.getPToken('honeywell').then(tokens => {
            //console.log("get all devices:", tokens);
            if(tokens instanceof Object) {
                // honeywell.getLocationId(tokens).then(location_id => {
                //     honeywell.subscribeToEvents(location_id, tokens, callback);
                // })
                honeywell.subscribeToEvents('1935763', tokens, callback);
            }
        });

        lifx.subscribeToEvents(callback);

        hue_local.createHueApi().then(api => {
            hue_local.subscribeToEvents(api, callback);
        })
    },

    subscribeToThingAdded(callback) {

    }
}


function test() {
    db.open();
    // lifx.controlLight('d073d55704b3', 'on');
    // lifx.controlLight('d073d5566fcd', 'on');
    getAllDevices();
}


if (typeof require !== 'undefined' && require.main === module) {
    test();
}


module.exports = CloudDeviceConnector;