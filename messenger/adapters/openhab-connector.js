/*
    Add devices on IoTMediator to openHAB (considered as a platform, not an internal component of IoTMediator)
*/


const MqttVDManager = require('./openhab-api').MqttVDManager;
const config = require('../../config/default');
const openhab_config = require('../../config/default').openhab;
const fs = require('fs');
const db = require('../core/db');
const device_connector = require('../connectors/device/device-connector');
const cloud_device_connector = require('../connectors/device/cloud-device-connector');
const hooks = require('../hooks');


DEBUG = true;

class OpenhabConnector {
    constructor() {
        this.manager = new MqttVDManager();
        this.devices = []; // devices
        this.VDs = [];
        this.beginHandleCommand();
    }

    createLocalVirtualDevice(device) {
        const VD = this.manager.createMqttVD(device.uid, device.label, device.attributes);
        this.devices.push(device);
        this.VDs.push(VD);
    }

    addDeviceToOpenhab(device) {
        //console.log(device);
        this.createLocalVirtualDevice(device);
        this.manager.add_openhab_device(device.uid, device.label, device.attributes);
        //console.log(this.manager.devices)
    }

    reportDeviceEventToOpenhab(event) {
        event = sanitizeValue(event);
        this.manager.reportData(event.device.uid, event.attribute, event.value);
    }

    beginHandleCommand() {
        this.manager.on('command', (topic, message) => {
            let uid = topic.split('/')[1];
            uid = uid.substring(uid.indexOf('mqtt:topic:')+'mqtt:topic:'.length);
            const attribute = topic.split('/')[2];
            const method = message.toString();
            if (config.verbose) console.debug('openhab-connector receives command:', uid, attribute, method);

            const device = this.findDeviceByUID(uid);
            if(device) {
                db.insertCommand({
                    device: {uid: uid, label: device.label},
                    attribute: attribute,
                    value: method,
                    platform: 'openhab',
                }).catch(err => {
                    console.error('insertCommand failed:', err);
                });
            }
            const commandContext = {
                platform: 'openhab',
                device: {uid: uid, label: device ? device.label : uid},
                attribute: attribute,
                value: method,
                is_cloud_device: device ? device.source !== 'openhab' : false,
                raw: {topic: topic.toString(), message: message.toString()},
            };
            hooks.handlePlatformCommand(commandContext, () => {
                if(device && attribute === 'switch') {
                    if(device.source === 'openhab') { // zigbee/zwave devices
                        for(let item of device.items) {
                            if(item.category === attribute) {
                                device_connector.sendCommandToItem(item, (method === 'on' ? 'ON' : 'OFF'));
                            }
                        }
                    } else { // cloud-connected devices
                        cloud_device_connector.sendCommandToDevice(uid, method);
                    }
                } else if(device && attribute === 'level') {
                    if(device.source === 'openhab') {
                        for(let item of device.items) {
                            if(item.category === attribute) {
                                device_connector.sendCommandToItem(item, method);
                            }
                        }
                    }
                }
                else {
                    console.error('cannot find device or unhandled command attribute: ', uid, attribute)
                }
            }).catch(err => {
                console.error('openhab command hook failed:', err);
            });
            
        })
    }

    findDeviceByUID(uid) {
        for(let device of this.devices) {
            if (device.uid === uid) {
                return device;
            }
        }
        return null;
    }
}

function sanitizeValue(event) { // obj is state or event
    switch(event.attribute) {
        case 'switch':
            event.value = ["on", "ON"].includes(event.value.toString()) ? 'on' : 'off';
            break;
        case 'contact':
            event.value = ["open", "OPEN"].includes(event.value.toString()) ? 'open' : 'closed';
            break;
        case 'temperature':
            event.value = event.value.toString().split(' ')[0];
            break;
        case 'motion':
            event.value = ["on", "ON", "active"].includes(event.value.toString()) ? 'active' : 'inactive';
            break;
        case 'water':
            res = ["ON", "wet"].includes(event.value)? 'wet': 'dry';
            break;
        case 'illuminance':
            event.value = event.value.toString().split(' ')[0];
            break;
        case 'humidity':
            event.value = event.value.toString().split(' ')[0];
            break;
        case 'power':
            event.value = event.value.toString().split(' ')[0];
            break;
        case 'level':
            event.value = event.value.toString().split(' ')[0];
            break;
        case 'button_group':
            event.value = event.value.toString();
            break;   
        default:
            console.log("###############default value: ", event.attribute, event.value);
            event.value = event.value.toString();
    }
    return event;
}

module.exports = {
    OpenhabConnector: OpenhabConnector,
}


if (typeof require !== 'undefined' && require.main === module) {
    let manager = new MqttVDManager();
    // create virtual devices on IoTMediator
    var motion_sensor1 = manager.createMqttVD('pfirewall_motionsensor1', 'motion sensor');    
    var switch1 = manager.createMqttVD('pfirewall_switch1', 'switch');
    var switch2 = manager.createMqttVD('pfirewall_switch2', 'switch');
    var contact_sensor1 = manager.createMqttVD('pfirewall_contactsensor1', 'contact sensor');
}
