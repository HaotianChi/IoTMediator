
/*
    This device connector is used to access devices from openHAB
*/

const request = require('request');
const config = require('../../config/default.js');
const https = require('https');
const http = require('http');
const format = require('string-format');

const DeviceConnector = {
    getAllItems: function() {
        return new Promise((resolve, reject) => {
            const url = config.device_connector.localhost + config.device_connector.get_all_items_url;
            request(url, {json: true}, (err, res, body) => {
                if(err) {reject(err);}
                var items = [];
                var each;
                try {
                    for(each of body) {
                        var item = {};
                        item.link = each.link;
                        item.state = each.state;
                        item.type = each.type;
                        item.name = each.name;
                        item.label = each.label;
                        item.category = each.category;
                        items.push(item);
                    }
                    resolve(items);
                } catch(err) {
                    console.log(err);
                }
            });
        });
    },

    getAllDevices: function() {
        return new Promise((resolve, reject) => {
            this.getAllItems().then(all_items => {
                //console.log(all_items)
                const url = config.device_connector.localhost + config.device_connector.get_all_things_url;
                request(url, {json: true}, (err, res, body) => {
                    if(err) {throw err;}
                    var devices = [];
                    var each_dev;
                    for (each_dev of body) {
                        if (config.device_connector.all_thing_type_uid.includes(each_dev.thingTypeUID) && each_dev.statusInfo.statusDetail !== "DISABLED") {
                            //console.log(each_dev)
                            var device = {};
                            device.status = each_dev.statusInfo.status;
                            device.label = each_dev.label;
                            device.uid = each_dev.UID;
                            device.thingTypeUID = each_dev.thingTypeUID;
                            var channels = [];
                            var items = [];
                            var each_channel;
                            for (each_channel of each_dev.channels) {
                                if (all_items != undefined) {
                                    var each_item;
                                    for (each_item of all_items) {
                                        if (each_item.name === each_channel.linkedItems[0]) {
                                            channel = {};
                                            channel.uid = each_channel.uid;
                                            channel.id = each_channel.id;
                                            channel.label = each_channel.label;
                                            channel.channelTypeUID = each_channel.channelTypeUID;
                                            channel.item = each_item;
                                            channels.push(channel);
                                            items.push(each_item);
                                        }
                                    }
                                }
                            }
                            device.channels = channels;
                            device.items = items;
                            device.source = 'openhab';
                            devices.push(device);
                        }
                    }
                    //console.log(devices);
                    resolve(devices);
                });
            });
        });
    },


    getDevice: function(id) {
        return new Promise((resolve, reject) => {
            this.getAllDevices().then((devices) => {
                var device;
                var found = false;
                for(device of devices) {
                    if (device.uid === id) {
                        found = true;
                        resolve(device);
                    }
                }
                resolve();
            })
        });
    },


    getItemState: function(item) {
        //console.log("getItemState is called");
        const url = config.device_connector.localhost + format(config.device_connector.get_item_state_url_template, item['name']);
        //console.log(url)
        return new Promise((resolve, reject) => {
            request(url, (err, res, body) => {
                if(err) {reject(err);}
                const state = body;
                resolve(state);
            });
        })
    },

    getAllItemStates: function() {
        var all_item_states = [];
        return new Promise((resolve, reject) => {
            this.getAllItems().then(all_items => {
                //console.log(all_items)
                if (all_items != undefined) {
                    var item;
                    var promises = [];
                    for(item of all_items) {
                        //console.log(item.name);
                        promises.push(this.getItemState(item));
                    }
                    //console.log(promises)
                    Promise.allSettled(promises).then((results) => {
                        //console.log(results);
                        var idx;
                        for(idx in results) {
                            state_obj = {};
                            state_obj.name = all_items[idx].name;
                            state_obj.category = all_items[idx].category;
                            state_obj.value = results[idx].value;
                            all_item_states.push(state_obj);
                        }
                        //console.log(all_item_states);
                        resolve(all_item_states);
                    })
                } else {
                    resolve(undefined);
                }
            });
        });
    },

    isItemActuatable: function(item) {
        if (config.device_connector.actuatable_item_categories.includes(item.category)) {
            return True;
        }
        else if (config.device_connector.all_item_categories.includes(item.category)) {
            return False
        }
        else {
            console.error('unknown item category: ', item.category);
        }       
    },

    /*
        command: [ON, OFF, UP, DOWN, REFRESH]
    */
    sendCommandToItem(item, command) {
        const url = config.device_connector.localhost + format(config.device_connector.send_command_to_item_url, item.name);
        //console.log(url);
        return new Promise((resolve, reject) => {
            request.post( {url: url, body: command}, (err, res, body) => {
                if(err) { reject(err); }
                if(res.statusCode === 200) {
                    resolve();
                } else {
                    reject(body);
                }
            });
        });
    },

    subscribeToAllItemStateChanged(callback) {
        const url = config.device_connector.localhost + config.device_connector.subscribe_to_all_item_statechanged_url;
        //console.log(url);
        request
            .get(url)
            .on('response', (response) => {
                if(response.statusCode === 200 && response.headers['content-type'] === 'text/event-stream') {
                    console.log('Subscribe to all item event successfully...');
                }
            })
            .on('data', (data) => {
                data = data.toString();
                data = data.split('\n')[1];
                const i = data.indexOf(':');
                data = data.slice(i+1);
                data = JSON.parse(data);
                var event = {};
                this.getAllDevices().then(all_devices => {
                    var device;
                    const target_name = data.topic.split('/')[2];
                    for(device of all_devices) {
                        var item;
                        for(item of device.items) {
                            if(item.name === target_name) {
                                event.item = item;
                                //console.log("event item:", item)
                                event.attribute = item.category;
                                event.device = device;
                                data = JSON.parse(data.payload)
                                event.value = data.value;
                                callback(event);
                            }
                        }

                    }
                }).catch(err => { throw err; })
            })
            .on('error', (err) => {
                console.error(err);
            })
    },

    subscribeToThingAdded(callback) {
        const url = config.device_connector.localhost + config.device_connector.subscribe_to_thing_added_url;
        //console.log(url);
        request
            .get(url)
            .on('response', (response) => {
                if(response.statusCode === 200 && response.headers['content-type'] === 'text/event-stream') {
                    console.log('Subscribe to all thing-added events successfully...');
                }
            })
            .on('data', (data) => {
                data = data.toString();
                data = data.split('\n')[1];
                const i = data.indexOf(':');
                data = data.slice(i+1);
                data = JSON.parse(data);
                const thing = JSON.parse(data.payload)
                const delayed = function() {
                    this.getDevice(thing.UID).then((device) => {
                        if(device) {
                            callback(device);
                        }
                    });
                }.bind(this);
                setTimeout(delayed, 5*60*1000);
            })
            .on('error', (err) => {
                console.error(err);
            })
    }
}


function callback(event) {
    console.log("callback is called...");
    console.log("event: ", event.item.name, event.item.category, event.value)
}

function test() {
    // DeviceConnector.getAllItems().then(data=> {console.log(data)});
    DeviceConnector.getAllDevices().then(devices=> {console.log(devices)});
    // DeviceConnector.getAllDevices().then( devices => {
    //     item = devices[0].items[0];
    //     DeviceConnector.getItemState(item);
    // }).catch(err => {throw err;});

    // DeviceConnector.getAllItems().then(items=> {
    //     var item;
    //     for(item of items) {
    //         if(item.name === 'PowerOutlet1_smartthings_Switch') {
    //             console.log(item)
    //             DeviceConnector.sendCommandToItem(item, 'OFF');
    //             break;
    //         }
    //     }
    // });
    DeviceConnector.subscribeToAllItemStateChanged(callback);
    // DeviceConnector.subscribeToThingAdded(callback);
    // DeviceConnector.getAllDeviceIds().then(ids => {console.log(ids)});
}


if (typeof require !== 'undefined' && require.main === module) {
    test();
}


module.exports = DeviceConnector;