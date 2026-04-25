const mosca = require('mosca');
const config = require('../../config/default')
const openhab_config = require('../../config/default').openhab;
const mqtt = require('mqtt');
const fs = require('fs');
const db = require('../core/db');
const request = require('request');
const EventEmitter = require('events');

DEBUG = true;

/*
    This is a MQTT broker placed on a local machine
*/

class MqttBroker {
    constructor(localport=openhab_config.ports.mqtt) {
        this.server = null;
        this.port = localport;
    }

    start() {
        this.server = new mosca.Server({port:this.port})
        this.server.on('ready', function() {
            console.log('Local MQTT broker ready !!!')
        })

        this.server.on('clientConnected', function(client) {
            console.log("MQTT client connected !!!", client.id)
        })

        this.server.on('published', function(packet, client) {
            var topic = packet.topic;
            switch(topic) {
                case 'test':
                    console.log('test');
                    console.log("broker receives message-publish: ", packet.payload.toString());
                    this.server.publish({topic: 'test', payload: packet.payload.toString()});
                    break;
                default:
                    console.log('default');
                    console.log("broker receives message-publish: ", packet.payload.toString());
            }
        })
    }
}

class MqttClient {
    constructor() {
        this.client = null;
        this.clientId = null;
    }

    connect(host=config.hosts.localhost, port=config.ports.mqtt, options={}) {
        var url = "mqtt://" + host + ":" + port;
        if(options.id) {
            this.client = mqtt.connect(url);
        } else {
            this.client = mqtt.connect(url, {clientId:options.id})
        }
        //console.log(this.client);
        this.clientId = this.client.options.clientId;
    }

    startHandleMessages() {
        this.client.on('message', function(topic, message) {
            console.log("received-message: " + topic + ':' + message.toString());
        })
    }

    subscribe(topiclist) {
        this.client.subscribe(topiclist);
    }

    publish(topic, payload) {
        //console.log("publish:", topic, payload);
        //this.client.publish(topic, JSON.stringify(payload), {qos:1, retain:true})
        this.client.publish(topic, payload, {qos:1, retain:true})
    }
}

class MqttVDManager extends EventEmitter {
    constructor(relay=null, policyManager=null) {
        console.log("Virtual Manager starts...");
        super();
        this.relay =relay;
        this.policyManager = policyManager;
        this.devices = [];
        this.deviceIds = [];
        this.brokerId = 'myMqttBroker1';
        this.brokerHost = '127.0.0.1';
        this.brokerSecure = false;

        this.add_openhab_broker(); // add an MQTT broker when the MqttVDManager is created

        // Reset OpenHAB generated configuration files when MqttVDManager relaunches.
        if(fs.existsSync(openhab_config.openhab_things_configuration_fullpath)) fs.unlinkSync(openhab_config.openhab_things_configuration_fullpath)
        if(fs.existsSync(openhab_config.openhab_items_configuration_fullpath)) fs.unlinkSync(openhab_config.openhab_items_configuration_fullpath)
    }


    /*
        Handle the commands received by virtual devices from the topic 'commands/'
        This currently emits commands to upper layers; forwarding to physical devices is handled separately.
    */
    handleReceivedCommands(topic, message) {
        // console.log('A device command is received: ', topic.toString().substring(topic.indexOf('/')+1), message.toString());
        this.emit('command', topic, message);
    }


    /*
        Create and initalize a MQTT virtual device
        Argumenets:
            model: device type
            id: identifier that will be used in openhab as well
    */
    createMqttVD(id, label, label_prefix="", attributes) {
        //console.log("createMqttVD-----------", id, label, attributes);
        //console.log("createMqttVD label:", label);
        // inspect if the device id already exists
        id = "mqtt:topic:" + id;
        label = label_prefix + label;
        let VD;
        let exists = false;
        for (let device of this.devices) {
            if(device.id === id) {
                exists = true;
                console.error(`device id: ${id} already exists in VDManager`);
                VD = device;
            }
        }
        if(!exists) {
            VD = new MqttVirtualDevice(id, label, attributes, this);
            VD.bindManager(this);
            VD.connect(openhab_config.hosts.mqtthost, openhab_config.ports.mqtt, {clientId: id});
            this.devices.push(VD);
            console.log('Successfully created a MQTT virtual device -- ', id, label, attributes);
            // VD.client.on('message', function(topic, message) {
            //     // received a command that is in message
            //     //
            //     console.log('Commands received: ', topic.toString().substring(topic.indexOf('/')+1) + ':' + message.toString());
            // });
            VD.startHandleMessages();
        }
        //console.log("createMqttVD VD.label:", VD.label);
        return VD;
    }


    /*
        Report data of a specified device
    */
    reportData(deviceId, attribute, value) {
        // console.log("reportData-----------", deviceId, attribute, value);
        deviceId = "mqtt:topic:" + deviceId;
        //var topic = 'data/' + deviceId.replace(/:/g, '') + '/' + attribute; // colons are not permitted in topic
        let topic = 'data/' + deviceId + '/' + attribute; // colons are not permitted in topic
        //console.log('Data reported: ', topic.toString(), value.toString());
        //device.publish(topic, {id: device.id, attribute: attribute, value: value});
        // console.log("reportData this.devices:", this.devices);
        for(let device of this.devices) {
            if(device.id === deviceId) {
                if (config.verbose) console.debug(`pushing to topic: ${topic}, value: ${value}, ${typeof(value)}, ${device.id}, ${device.label}, ${device.attributes}`);
                device.publish(topic, value.toString());
            }
        }
        
    }


    // this function generate a configuration file for openhab
    add_openhab_broker() {
        const content = `mqtt:broker:${this.brokerId} [ host=\"${this.brokerHost}\", secure=${this.brokerSecure} ]`;  
        try {
            fs.writeFileSync(openhab_config.openhab_broker_configuration_fullpath, content);
        } catch(err) {
            console.error(err);
        }
    }

    // get the ids of all devices that have been added to openhab via MQTT integration
    get_all_openhab_device_ids() {
        return new Promise((resolve, reject) => {
            const url = openhab_config.hosts.localhost + openhab_config.get_all_things_url;
            request(url, {json: true}, (err, res, body) => {
                if(err) {throw err;}
                let ids = [];
                for (let each_dev of body) {
                    if (each_dev.thingTypeUID === 'mqtt:topic' && each_dev.statusInfo.statusDetail !== "DISABLED") {
                        //console.log(each_dev)
                        ids.push(each_dev.UID);
                    }
                }
                resolve(ids);
            });
        });
    }


    add_openhab_device(id, label, attributes, id_prefix="mqtt:topic:", label_prefix="") {
        //console.log("add_openhab_device-----------", id, label, attributes);
        let exists = false;
        id = id_prefix + id;
        label = label_prefix + label;
        let id4topic = id;//.replace(/:/g, '');
        if (config.verbose) console.debug("add_openhab_device invoked");
        // Read existing device ids from OpenHAB runtime state.
        //let openhabDeviceIds = JSON.parse(fs.readFileSync('existingOpenhabDeviceIds.json'));
        this.get_all_openhab_device_ids().then(ids => {
            // console.log(openhabDeviceIds);
            for (let existedid of ids) {
                if(existedid === id) {
                    exists = true;
                    console.log(`device id: ${id} already exists in openHAB`);
                }
            }
            if(!exists) {
                if(fs.existsSync(openhab_config.openhab_things_configuration_fullpath)) {
                    let content = fs.readFileSync(openhab_config.openhab_things_configuration_fullpath, {encoding:'utf8'});
                    // remove the last line
                    content = content.split(/\r?\n/);
                    //console.log(content);
                    content.pop();
                    //console.log(content);
                    content = content.join('\r\n');
                    //console.log(content);
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, content);
                    // add the device
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, `\n\tThing ${id} \"${label}\" \{\n`, {flag:'as'});
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\tChannels:\n', {flag:'as'});
                    for(let attr of attributes) {
                        if (config.sensor_attributes.includes(attr)) {
                            //fs.writeFileSync(things_configuration_dir+things_filename, `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id}/${attr}\" ]\n`, {flag:'as'});
                            let channel_content, item_content;
                            switch(attr) {
                                case 'motion':
                                    channel_content = `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `String ${label}_${attr} \"${attr} [%s]\" <motion> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'level':
                                    channel_content = `\t\tType dimmer : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`
                                    item_content = `Dimmer ${label}_${attr} \"${attr} [%s]\" <level> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'illuminance':
                                    channel_content = `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `String ${label}_${attr} \"${attr} [%s]\" <illuminance> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'button_group':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%s]\" <button_group> {channel=\"${id}:${attr}\"}\n`;
                                    break;          
                                case 'temperature':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%.1f C]\" <temperature> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'contact':
                                    channel_content = `\t\tType contact : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", on=\"open\", off=\"closed\"]\n`
                                    item_content = `Contact ${label}_${attr} \"${attr} [%s]\" <contact> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'power':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%.1f W]\" <power> {channel=\"${id}:${attr}\"}\n`
                                    break;
                                case 'water':
                                    channel_content = `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `String ${label}_${attr} \"${attr} [%s]\" <water> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'humidity':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%s %%]\" <humidity> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                default:
                                    console.log('##########################unhandled attribute!!!#######################', attr);
                            }
                            fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, channel_content, {flag:'as'});
                            fs.writeFileSync(openhab_config.openhab_items_configuration_fullpath, item_content, {flag:'a'});
                        } else if (config.actuator_attributes.includes(attr)) {
                            let channel_content, item_content;
                            switch(attr) {
                                case 'switch':
                                    channel_content = `\t\tType switch : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`;
                                    item_content = `Switch ${label}_${attr} \"${attr} [%s]\" <${attr}> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'valve':
                                    channel_content = `\t\tType switch : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`;
                                    item_content = `Switch ${label}_${attr} \"${attr} [%s]\" <${attr}> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'lock':
                                    channel_content = `\t\tType switch : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`;
                                    item_content = `Switch ${label}_${attr} \"${attr} [%s]\" <${attr}> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                default:
                                    console.log('##########################unhandled attribute!!!#######################', attr);
                            }
                            fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, channel_content, {flag:'as'});
                            fs.writeFileSync(openhab_config.openhab_items_configuration_fullpath, item_content, {flag:'a'});
                        } else {
                            console.log('##########################unhandled attribute!!!#######################', attr);
                        }
                    }
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\t\}\n', {flag:'as'});
                    // restore the last line
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\}', {flag:'as'});

                } else {
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, `Bridge mqtt:broker:${this.brokerId} [ host=\"${this.brokerHost}\", secure=${this.brokerSecure} ]\n`);
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\{\n', {flag:'as'});

                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, `\tThing ${id} \"${label}\" \{\n`, {flag:'as'});
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\tChannels:\n', {flag:'as'});

                    for(let attr of attributes) {
                        if (config.sensor_attributes.includes(attr)) {
                            //fs.writeFileSync(things_configuration_dir+things_filename, `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id}/${attr}\" ]\n`, {flag:'as'});
                            let channel_content, item_content;
                            switch(attr) {
                                case 'motion':
                                    channel_content = `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `String ${label}_${attr} \"${attr} [%s]\" <motion> {channel=\"${id4topic}:${attr}\"}\n`;
                                    break;
                                case 'level':
                                    channel_content = `\t\tType dimmer : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`
                                    item_content = `Dimmer ${label}_${attr} \"${attr} [%s]\" <level> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'illuminance':
                                    channel_content = `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `String ${label}_${attr} \"${attr} [%s]\" <illuminance> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'button_group':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%s]\" <button_group> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'temperature':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%.1f C]\" <temperature> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'contact':
                                    channel_content = `\t\tType contact : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", on=\"open\", off=\"closed\" ]\n`
                                    item_content = `Contact ${label}_${attr} \"${attr} [%s]\" <contact> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'power':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%.1f W]\" <power> {channel=\"${id}:${attr}\"}\n`
                                    break;
                                case 'water':
                                    channel_content = `\t\tType string : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `String ${label}_${attr} \"${attr} [%s]\" <water> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'humidity':
                                    channel_content = `\t\tType number : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\" ]\n`
                                    item_content = `Number ${label}_${attr} \"${attr} [%s %%]\" <humidity> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                default:
                                    console.log('##########################unhandled attribute!!!#######################', attr);
                            }
                            fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, channel_content, {flag:'as'});
                            fs.writeFileSync(openhab_config.openhab_items_configuration_fullpath, item_content, {flag:'a'});
                        } else if (config.actuator_attributes.includes(attr)) {
                            let channel_content, item_content;
                            switch(attr) {
                                case 'switch':
                                    channel_content = `\t\tType switch : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`;
                                    item_content = `Switch ${label}_${attr} \"${attr} [%s]\" <${attr}> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'valve':
                                    channel_content = `\t\tType switch : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`;
                                    item_content = `Switch ${label}_${attr} \"${attr} [%s]\" <${attr}> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                case 'lock':
                                    channel_content = `\t\tType switch : ${attr} \"${attr}\" [ stateTopic=\"data/${id4topic}/${attr}\", commandTopic=\"commands/${id4topic}/${attr}\", on=\"on\", off=\"off\" ]\n`;
                                    item_content = `Switch ${label}_${attr} \"${attr} [%s]\" <${attr}> {channel=\"${id}:${attr}\"}\n`;
                                    break;
                                default:
                                    console.log('##########################unhandled attribute!!!#######################', attr);
                            }
                            fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, channel_content, {flag:'as'});
                            fs.writeFileSync(openhab_config.openhab_items_configuration_fullpath, item_content, {flag:'a'});
                        } else {
                            console.log('##########################unhandled attribute!!!#######################');
                        }
                    }
                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\t\}\n', {flag:'as'});

                    fs.writeFileSync(openhab_config.openhab_things_configuration_fullpath, '\}', {flag:'as'});

                }
            }
        });
    }
}



class MqttVirtualDevice extends MqttClient{
    constructor(id, label, attributes, manager) {
        super();
        // this.client = null;
        // this.clientId = null;
        this.id = id; // device id
        this.label = label;
        this.attributes=attributes; // a set of supported attributes
        this.values = {}; // {attribute1: value1, attribute2: value2}
        this.manager = manager;
        this.topics = [];

        for (var attribute in this.attributes) {
            this.values.attribute = null;
        }
    }

    setId(id) {
        this.id = id;
    }

    subscribe(topiclist) {
        this.client.subscribe(topiclist);
    }

    bindManager(manager) {
        if (this.manager == null) {
            this.manager = manager;
        }
    }

    connect(host=config.hosts.localhost, port=config.ports.mqtt, options={}) {
        var url = "mqtt://" + host + ":" + port;
        if(options.id) {
            this.client = mqtt.connect(url);
        } else {
            this.client = mqtt.connect(url, {clientId:options.id})
        }
        //console.log(this.client);
        this.clientId = this.client.options.clientId;

        // start handling received commands
        //this.topics.push('commands/' + this.id.replace(/:/g, '') + '/#')
        this.topics.push('commands/' + this.id + '/#')

        //this.subscribe(this.topics);
        //this.subscribe('commands/' + this.id.replace(/:/g, '') + '/#');
        this.subscribe('commands/' + this.id + '/#');
    }

    messageCallback(topic, message) {
        // received a command that is in message
        // Forward command handling can be extended here when needed.
        //console.log("mqtt-VD received-message: " + message.toString());
        if (this.manager != null) {
            this.manager.handleReceivedCommands(topic, message);
        } else {
            console.log("mqtt-VD has no manager...");
        }
    //}
    }

    startHandleMessages() {
        //console.log("startHandlerMessages", this);
        this.messageCallback = this.messageCallback.bind(this);
        this.client.on('message', this.messageCallback);
    }
}




module.exports = {
    MqttBroker: MqttBroker,
    MqttClient: MqttClient,
    MqttVirtualDevice: MqttVirtualDevice,
    MqttVDManager: MqttVDManager,
}



if (typeof require !== 'undefined' && require.main === module) {
    // console.log("mqtt broker is launched");
    // broker = new MqttBroker();
    // broker.start();

    let manager = new MqttVDManager();

    // // create virtual devices on IoTMediator
    // var motion_sensor1 = manager.createMqttVD('pfirewall_motionsensor1', 'MotionSensor1', ['motion']);    
    // var switch1 = manager.createMqttVD('pfirewall_switch1', 'SmartOutlet1', ['switch', 'power']);
    // var switch2 = manager.createMqttVD('pfirewall_switch2', 'Light1', ['switch']);
    // var contact_sensor1 = manager.createMqttVD('pfirewall_contactsensor1', 'ContactSensor1', ['contact', 'temperature']);

    // // add new devices to openhab
    // manager.add_openhab_device('pfirewall_motionsensor1', 'MotionSensor1', ['motion']);
    // manager.add_openhab_device('pfirewall_switch1', 'SmartOutlet1', ['switch', 'power']);
    // manager.add_openhab_device('pfirewall_switch2', 'Light1', ['switch']);
    // manager.add_openhab_device('pfirewall_contactsensor1', 'ContactSensor1', ['contact', 'temperature']);

    // // initialize device states by reporting data to openhab
    // manager.reportData('pfirewall_motionsensor1', 'motion', 'inactive');
    // manager.reportData('pfirewall_contactsensor1', 'contact', 'closed');
    // manager.reportData('pfirewall_contactsensor1', 'temperature', '72');
    // manager.reportData('pfirewall_switch1', 'power', '10');
    // manager.reportData('pfirewall_switch1', 'switch', 'off');
    // manager.reportData('pfirewall_switch2', 'switch', 'off');


    // setTimeout(()=> {
    //     manager.reportData('pfirewall_motionsensor1', 'motion', 'active');
    //     manager.reportData('pfirewall_contactsensor1', 'contact', 'open');
    //     manager.reportData('pfirewall_contactsensor1', 'temperature', '80');
    //     manager.reportData('pfirewall_switch1', 'power', '1300');
    // }, 15000)
    manager.get_all_openhab_device_ids().then(ids => { if (config.verbose) console.debug(ids); });

    var contact_sensor1 = manager.createMqttVD('contactsensor1', 'ContactSensor1', ['contact', 'temperature']);
    manager.add_openhab_device('contactsensor1', 'ContactSensor1', ['contact', 'temperature']);
    manager.reportData('contactsensor1', 'temperature', '40');
    manager.reportData('contactsensor1', 'contact', 'open');
}

