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
    createSimulatedDevice('lockdevice1', 'Lock1_ifttt', ['lock']);
    createSimulatedDevice('wetdevice1', 'WetDevice1_ifttt', ['water', 'humidity']);
    createSimulatedDevice('valvedevice1', 'Valve1_ifttt', ['valve']);
    
    createSimulatedDevice('switch1', 'GenericSwitch1_ifttt', ['switch']);
    createSimulatedDevice('lightbulb1', 'LightBulb1_ifttt', ['contact']);
    createSimulatedDevice('temperaturesensor1', 'TemperatureSensor1_ifttt', ['temperature']);
    createSimulatedDevice('motionsensor1', 'MotionSensor1_ifttt', ['motion']);
    createSimulatedDevice('multidevice1', 'MultiDevice1_ifttt', ['power', 'illuminance', 'level', 'button_group']);

    console.log("here");
    
    setTimeout(() => {
        sendEvent('lockdevice1', 'lock', 'locked');
    }, 1000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('wetdevice1', 'water', 'wet');
    }, 2000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('wetdevice1', 'humidity', '34');
    }, 3000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('valvedevice1', 'valve', 'closed');
    }, 4000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('switch1', 'switch', 'on');
    }, 5000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('temperaturesensor1', 'temperature', '-1.03');
    }, 6000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('lightbulb1', 'contact', 'open');
    }, 7000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'active');
    }, 8000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'power', 101);
    }, 9000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'level', 3);
    }, 10000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'power', 101);
    }, 11000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'inactive');
    }, 12000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'inactive');
    }, 13000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'inactive');
    }, 14000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('lightbulb1', 'contact', 'closed');
    }, 15000); // send these events after N seconds

    setTimeout(() => {
        sendEvent('multidevice1', 'power', '101');
    }, 16000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'level', '90');
    }, 17000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'illuminance', '68');
    }, 18000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'button_group', '2');
    }, 19000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'level', "3");
    }, 20000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('multidevice1', 'power', "101");
    }, 21000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('lightbulb1', 'contact', 'closed');
    }, 22000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'inactive');
    }, 23000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'inactive');
    }, 24000); // send these events after N seconds

    setTimeout(() => {
        sendEvent('wetdevice1', 'water', 'dry');
    }, 25000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('wetdevice1', 'humidity', '90');
    }, 26000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('lockdevice1', 'lock', 'unlocked');
    }, 27000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('valvedevice1', 'valve', 'open');
    }, 28000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('lightbulb1', 'contact', 'closed');
    }, 29000); // send these events after N seconds
    setTimeout(() => {
        sendEvent('motionsensor1', 'motion', 'inactive');
    }, 30000); // send these events after N seconds

}
