/*
    This script is used to create simulated devices on openHAB for testing.
    New devices can be created and events of these devices can be manipulated.
*/
const MqttVDManager = require('../../messenger/connectors/platform/openhab-api').MqttVDManager;
const manager = new MqttVDManager();

function createSimulatedDevice(deviceId, label, attributes) {
    const simulatedDevice = manager.createMqttVD(deviceId, label, attributes); // this only adds the device locally in the manager itself 
    manager.add_openhab_device(deviceId, label, attributes);
    return simulatedDevice;
}

function sendEvent(deviceId, attribute, value) {
    manager.reportData(deviceId, attribute, value);
}


if (typeof require !== 'undefined' && require.main === module) {
    createSimulatedDevice('contactsensor1', 'ContactSensor1', ['contact', 'temperature']);
    createSimulatedDevice('motionsensor1', 'MotionSensor1', ['motion']);
    createSimulatedDevice('switch1', 'SmartOutlet1', ['switch', 'power']);
    createSimulatedDevice('switch2', 'Light1', ['switch']);

    console.log("here");

    sendEvent('contactsensor1', 'temperature', '72');
    sendEvent('contactsensor1', 'contact', 'closed');
    sendEvent('motionsensor1', 'motion', 'inactive');
    sendEvent('switch1', 'power', '0');
    sendEvent('switch1', 'switch', 'off');
    sendEvent('switch2', 'switch', 'off');


    setTimeout(() => {
        sendEvent('contactsensor1', 'temperature', '780');
        sendEvent('contactsensor1', 'contact', 'open');
        sendEvent('motionsensor1', 'motion', 'active');
        sendEvent('switch1', 'power', '1000');
        sendEvent('switch1', 'switch', 'on');
        sendEvent('switch2', 'switch', 'on');
    }, 20*1000); // send these events after N seconds
}
