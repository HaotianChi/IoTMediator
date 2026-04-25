'use strict';
const path = require('path');

const PORT = 3500;
const realIntegrationEnabled = process.env.IOTMEDIATOR_REAL_INTEGRATION === 'true';

module.exports = {
    PORT: PORT,
    BASE_URL: process.env.BASE_URL || `http://127.0.0.1:${PORT}`,
    __basedir: path.join(__dirname, '../'),
    
    mode: 'dev',
    real_integration_enabled: realIntegrationEnabled,

    no_authentication: false,
    verbose: false,
    okta: {
        okta_org_url: process.env.OKTA_ORG_URL || 'https://example.okta.com',
        okta_api_token: process.env.OKTA_API_TOKEN || '',
        okta_client_id: process.env.OKTA_CLIENT_ID || '',
        okta_client_secret: process.env.OKTA_CLIENT_SECRET || '',
    },

    sensor_attributes: ['motion', 'contact', 'temperature', 'power', 'humidity', 'water', 'illuminance', 'level', 'button_group'],
    actuator_attributes: ['switch', 'valve', 'lock'],

    device_connector: {
        localhost: "http://127.0.0.1:8080",
        subscribe_to_all_item_command_url: "/rest/events?topics=smarthome/items/*/command",
        subscribe_to_all_item_statechanged_url: "/rest/events?topics=smarthome/items/*/statechanged",
        subscribe_to_thing_added_url: "/rest/events?topics=smarthome/things/*/added",
        get_thing_url: "/rest/things/{}",
        get_all_things_url: "/rest/things",
        get_all_items_url: "/rest/items?recursive=false",
        get_item_state_url_template: "/rest/items/{}/state",
        send_command_to_item_url: "/rest/items/{}",

        all_thing_type_uid: ['zigbee:device', 'mqtt:topic'],
        all_item_categories: ['switch', 'motion', 'power', 'battery', 'contact', 'lock'],
        actuatable_item_categories: ['switch', 'lock'],
    },

    cloud_device_connector: {
        all_thing_type_uid: ['cloud:device'],
        actuatable_attributes: ['switch', 'lock', 'valve'],
        all_attributes: ['switch', 'motion', 'power', 'battery', 'contact', 'lock', 'temperature', 'valve', 'humidity', 'water'],

        honeywell: {
            apikey: process.env.HONEYWELL_API_KEY || '',
            apisecret: process.env.HONEYWELL_API_SECRET || '',
            credential_base64: process.env.HONEYWELL_CREDENTIAL_BASE64 || '',
            redirectUri: process.env.HONEYWELL_REDIRECT_URI || 'https://example.com/honeywell/oauth2/redirect',
            AUTHORIZATION_URL: process.env.HONEYWELL_AUTHORIZATION_URL || '',
        },

        lifx: {
            bearerToken: process.env.LIFX_BEARER_TOKEN || '',
        },

        hue: {
            clientId: process.env.HUE_CLIENT_ID || '',
            clientSecret: process.env.HUE_CLIENT_SECRET || '',
            appId: process.env.HUE_APP_ID || 'iotmediator',
            local_username: process.env.HUE_LOCAL_USERNAME || '',
        },
    },

    smartthings: {
        account_name: process.env.SMARTTHINGS_ACCOUNT_NAME || 'smartthings@example.com',
        mp_client_id: process.env.SMARTTHINGS_MP_CLIENT_ID || 'iotmediator-client-id',
        mp_client_secret: process.env.SMARTTHINGS_MP_CLIENT_SECRET || 'iotmediator-client-secret',
        client_id: process.env.SMARTTHINGS_CLIENT_ID || '',
        client_secret: process.env.SMARTTHINGS_CLIENT_SECRET || '',
        permitted_redirect_urls: "https://c2c-us.smartthings.com/oauth/callback,https://c2c-eu.smartthings.com/oauth/callback,https://c2c-ap.smartthings.com/oauth/callback,https://c2c-globals.smartthingsgdev.com/oauth/callback,https://c2c-globald.smartthingsgdev.com/oauth/callback,https://c2c-uss.smartthingsgdev.com/oauth/callback,https://c2c-eus.smartthingsgdev.com/oauth/callback,https://c2c-usd.smartthingsgdev.com/oauth/callback"
    },

    ifttt: {
        account_name: process.env.IFTTT_ACCOUNT_NAME || 'ifttt_user',
        mp_client_id: process.env.IFTTT_MP_CLIENT_ID || 'iotmediator-ifttt-id',
        mp_client_secret: process.env.IFTTT_MP_CLIENT_SECRET || 'iotmediator-ifttt-secret',
        service_key: process.env.IFTTT_SERVICE_KEY || '',
        redirect_uri: process.env.IFTTT_REDIRECT_URI || 'https://ifttt.com/channels/iotmediator/authorize',
    },

    alexa: {
        mp_client_id: process.env.ALEXA_MP_CLIENT_ID || '',
        mp_client_secret: process.env.ALEXA_MP_CLIENT_SECRET || '',
        client_id: process.env.ALEXA_CLIENT_ID || '',
        client_secret: process.env.ALEXA_CLIENT_SECRET || '',
        event_endpoint_url: 'https://api.amazonalexa.com/v3/events',
        lwa_token_url: 'https://api.amazon.com/auth/o2/token'
    },

    openhab: {
        ports: {
            mqtt: 1883,
        },
        hosts: {
            mqtthost: '127.0.0.1',
            localhost: 'http://127.0.0.1:8080',
        },
        get_all_things_url: "/rest/things",
        openhab_things_configuration_dir: '/etc/openhab2/things/',
        openhab_things_configuration_fullpath: '/etc/openhab2/things/mp_mqtt1.things',
        openhab_items_configuration_dir: '/etc/openhab2/items/',
        openhab_items_configuration_fullpath: '/etc/openhab2/items/mp_mqtt1.items',
        openhab_broker_configuration_fullpath: '/etc/openhab2/things/broker1.things',
    },

    removeBeforeOpen: false,
}
