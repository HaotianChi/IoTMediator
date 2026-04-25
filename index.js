
require('dotenv').config();
const config = require('./config/default.js');
const express = require('express');
const morgan = require('morgan');
var createError = require('http-errors');
var path = require('path');
const session = require('express-session');
const okta = require("@okta/okta-sdk-nodejs");
const {ExpressOIDC} = require('@okta/oidc-middleware');

const {StateUpdateRequest} = require('st-schema');
const https = require('https');
const http = require('http');
const fs = require('fs');
const db = require('./messenger/core/db.js');
const api_ST = require('./messenger/connectors/platform/smartthings-api');
const utility = require('./messenger/core/utility');
let notify = require('./messenger/connectors/platform/ifttt/realtime');
const hooks = require('./hooks');
const {stream_handler} = require('./handling');

//=============================================================
// User management and web interfaces
//=============================================================

const dashboardRouter = require('./routes/dashboard');
const publicRouter = require('./routes/public');
const usersRouter = require('./routes/users');
// const authorizationCodeRouter = require('./routes/authorization-code');
const profileRouter = require('./routes/profile');


//=============================================================
// Cloud-based integration with platforms
//=============================================================

// URL router for SmartThings
const {router_connector_ST, formatEvent4ST, formatDevice4ST} = require('./messenger/adapters/smartthings-connector');
const router_oauth2_ST = require('./routes/oauth/smartthings/oauth2.js');
// URL router for IFTTT
const router_connector_ifttt = require('./messenger/adapters/ifttt-connector');
const router_oauth2_ifttt = require('./routes/oauth/ifttt/oauth2.js');
// URL router for Alexa
const router_connector_alexa = require('./messenger/adapters/alexa-connector');
const router_oauth2_alexa = require('./routes/oauth/alexa/oauth2.js');
const alexa_api = require('./messenger/connectors/platform/alexa-api.js')


//=============================================================
// Cloud-based integration with devices
//=============================================================

// URL router for Honeywell
const router_oauth2_honeywell = require('./routes/oauth/honeywell/oauth2.js');
// URL router for Philips Hue
const router_oauth2_hue = require('./routes/oauth/hue/oauth2.js');


//=============================================================
// Local-based integration with platforms
//=============================================================

// openHAB connector
let openhab_connector = null;
if (config.real_integration_enabled) {
    const OpenhabConnector = require('./messenger/adapters/openhab-connector').OpenhabConnector;
    openhab_connector = new OpenhabConnector();
}

function normalizeDeviceEvent(event) {
    let attribute = event.attribute;
    if (!attribute && event.item && event.item.category) {
        attribute = event.item.category;
    }
    return {
        device: event.device,
        attribute: attribute,
        value: event.value,
        raw: event,
    };
}

hooks.setStreamHandler(stream_handler);


//=============================================================
// IoTMediator setup
//=============================================================
// utility.monitorInternetConnetions(); // Monitor the status of Internet connection

// Create a default account for logging into IoTMediator in development mode
if(config.mode === 'dev') {
    db.addAccount("test@iotmediator.com", "test");
}

const app = express();
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    throw new Error('Missing required environment variable: SESSION_SECRET');
}

const oktaClient = new okta.Client({
    orgUrl: config.okta.okta_org_url,
    token: config.okta.okta_api_token
}); // used to retrieve user data from the Okta API service
  
  
const oidc = new ExpressOIDC({
    issuer: `${config.okta.okta_org_url}/oauth2/default`,
    client_id: config.okta.okta_client_id,
    client_secret: config.okta.okta_client_secret,
    appBaseUrl: config.BASE_URL,
    scope: "openid profile",
    routes: {
        login: {
            path: "/users/login"
        },
        loginCallback: {
            path: "/authorization-code/callback",
            afterCallback: "/dashboard"
        }
    }
}); // handles all of the OpenID Connect protocol support e.g., user registration, login, password reset, etc.

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(express.json());
app.use(morgan(":method :url :status :response-time ms"));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: false
  }));
app.use(oidc.router);

// Authentication middleware
app.use((req, res, next) => {
    if (config.verbose) console.debug("userinfo:", req.userContext);
    if(req.isAuthenticated()) {
      oktaClient.getUser(req.userContext.userinfo.sub)
      .then(user => {
        if (config.verbose) console.debug("user:", user.credentials);
        req.user = user;
        res.locals.user = user;
        next();
      }).catch(err => {
        next(err);
      });
    } else {
      next();
    }
});

// Routes
app.use('/', publicRouter);
app.use('/dashboard', loginRequired, dashboardRouter);
app.use('/users', usersRouter);
// app.use('/authorization-code', authorizationCodeRouter);
app.use('/profile', loginRequired, profileRouter);

if (config.real_integration_enabled) {
    app.use('/smartthings', router_connector_ST); // integration with SmartThings
    app.use('/smartthings/oauth2', router_oauth2_ST);
    app.use('/ifttt', router_connector_ifttt); // integration with IFTTT
    app.use('/ifttt/oauth2', router_oauth2_ifttt);
    app.use('/alexa', router_connector_alexa); // integration with Alexa
    app.use('/alexa/oauth2', router_oauth2_alexa);

    app.use('/honeywell/oauth2', router_oauth2_honeywell);
    app.use('/hue/oauth2', router_oauth2_hue);
}

app.get('/test', (req, res) => {
    if(!req.user) {
        res.redirect('/users/login');
    } else {
        res.send(JSON.stringify(req.user.profile));
    }
});


// catch 404 and forward to error handler
app.use(function(req, res, next) {
    next(createError(404));
});
  
// error handler
app.use(function(err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
  
    // render the error page
    res.status(err.status || 500);
    res.render('website/error');
});


//===========================================================
// Initialize the databases
//===========================================================
db.open();


// Initialize devices that have been connected to openHAB by
// adding them to the local database and register them with the target platform
let deviceConnector = null;
let cloudDeviceConnector = null;
if (config.real_integration_enabled) {
    deviceConnector = require('./messenger/connectors/device/device-connector');
    db.initializeDevices(deviceConnector).then(devices => {
        db.initializeStates(devices).then(states => {
            for(let device of devices) {
                pushDeviceToTargetPlatform(device, device.platform);
            }
        });
    }).catch(err => {console.error(err);});
}

// Listen to new device events to
// update the database and push the events to the target platform
if (config.real_integration_enabled && deviceConnector) {
deviceConnector.subscribeToAllItemStateChanged((event) => {
    const hookEvent = normalizeDeviceEvent(event);
    hooks.handleDeviceEvent(hookEvent, async () => {
        try {
            await db.insertEvent(event);
        } catch (err) {
            console.error(err);
        }
        try {
            await db.updateState(event);
        } catch (err) {
            console.error(err);
        }
        try {
            const target_platform = await db.getEventTargetPlatform(event);
            console.log(`New event: ${event.device.uid}, ${event.device.label}, ${event.attribute}, ${event.value}, target platform: ${target_platform}`);
            pushEventToTargetPlatform(event, target_platform);
        } catch (err) {
            console.error(err);
        }
    }).catch(err => {
        console.error('device event hook failed:', err);
    });
});
}

// Listen to devices that are newly added to openHAB
// add them to the local database and register them with the target platform
if (config.real_integration_enabled && deviceConnector) {
deviceConnector.subscribeToThingAdded((device) => {
    db.initializeDevices(deviceConnector).then(devices => {
        db.initializeStates(devices).then(states => {
            pushDeviceToTargetPlatform(device, device.platform);
        });
    }).catch(err => {console.error(err);});;
});
}


// Initialize cloud devices connected through vendor clouds.
// The current startup flow first requests/stores tokens, then requests/stores cloud devices.
// A dedicated UI-triggered integration flow should replace this startup sequence in production.

if (config.real_integration_enabled) {
    cloudDeviceConnector = require('./messenger/connectors/device/cloud-device-connector');
    cloudDeviceConnector.requestIntegrateDevices();
    db.initializeCloudDevices(cloudDeviceConnector).then(devices => {
        for(let device of devices) {
            pushDeviceToTargetPlatform(device, device.platform);
        }
        db.initializeCloudDeviceStates(devices).then(devices => {
            cloudDeviceConnector.subscribeToEvents((event) => {  
                const hookEvent = normalizeDeviceEvent(event);
                hooks.handleDeviceEvent(hookEvent, async () => {
                    try {
                        await db.insertCloudDeviceEvent(event);
                    } catch (err) {
                        console.error(err);
                    }
                    try {
                        await db.updateCloudDeviceState(event);
                    } catch (err) {
                        console.error(err);
                    }
                    try {
                        const target_platform = await db.getEventTargetPlatform(event);
                        console.log(`New event: ${event.device.uid}, ${event.device.label}, ${event.attribute}, ${event.value}, target platform: ${target_platform}`);
                        pushEventToTargetPlatform(event, target_platform);
                    } catch (err) {
                        console.error(err);
                    }
                }).catch(err => {
                    console.error('device event hook failed:', err);
                });
            });
        });
    }).catch(err => {console.error(err);});
}



function pushEventToTargetPlatform(event, target) {
    if (!config.real_integration_enabled) {
        return;
    }
    switch(target) {
        case 'smartthings':
            formatEvent4ST(event).then((deviceState) => {
                //console.log(`New event: ${event.device.label}, ${event.attribute}, ${event.value}, target platform: ${target}`);
                //console.log("deviceState in index:", deviceState[0].states);
                api_ST.push_device_state(deviceState);
            });
            break;
        case 'openhab':
                openhab_connector.reportDeviceEventToOpenhab(event);
            break;
        case 'ifttt':
            // Notify IFTTT Real time endpoint
            let device_id = event.device.uid;
            db.getTriggerIdentities(device_id)
            .then((trigger_identities) => {
                console.log("Device data successfully changed (index)");
                // Notifies IFTTT that device status has changed if it is needed
                if (trigger_identities != null && trigger_identities.length != 0) {
                    return notify(trigger_identities);
                } else {
                    // console.log("Device data not changed");
                }
            });
            break;
        case 'alexa':
                alexa_api.reportDeviceEventToAlexaEventGateway(event);
            break;
        default:
            // console.error("Unknown target platform of event device:", event.device);
    }
}


function pushDeviceToTargetPlatform(device, target) {
    if (!config.real_integration_enabled) {
        return;
    }
    switch(target) {
        case 'smartthings':
            const device_ST = formatDevice4ST(device);
            if(device_ST) {
                api_ST.push_device_discovery(device_ST);
            }
            break;
        case 'openhab':
            openhab_connector.addDeviceToOpenhab(device);
            break;
        case 'ifttt':
            
            break;
        case 'alexa':

            break;
        default:
            console.error("Unknown the target platform of device:", device.label);
    }
}

function loginRequired(req, res, next) {
    if(!req.user) {
      return res.status(401).render("website/unauthenticated");
    }
    next();
}



module.exports = app;
