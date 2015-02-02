var ip = require('ip');
var moment = require('moment');
var _ = require('underscore');
var db = require('../lib/db');
var app = require('../app');
var debug = require('debug')(app.get('debugns')+':model:Device');

var UDP_RANGE_START = '10.2.0.2';
var UDP_RANGE_END = ip.toLong('10.2.99.251');
var TCP_RANGE_START = '10.1.0.2';
var TCP_RANGE_END = ip.toLong('10.1.99.251');

/** Device JSON schema.
 * 
 *  The device type should be one of [ipad, iphone, macbook, imac, windows-pc, 
 *  linux-pc, linux-laptop, windows-laptop, android-phone, android-tablet]
 *
 *  Devices can connect to the OpenVPN tunnel using login (which is just 
 *  username.devname) and the password associated to username 
 *  (see User schema). 
 *
 *  Devices with defined 'removed', should not be able to login.
 */
var DeviceSchema = new db.Schema({
    login : {type:String, required: true, unique: true},
    username : {type:String, required: true, unique: false},
    devname : {type:String, required: true, unique: false},
    type : {type:String, required: true, unique: false},
    usage : {type:String, required: true, unique: false},
    created: {type:Date, default: Date.now},
    removed: {type:Date, required: false},
    app_uuid : {type:String, required: false},
    app_lastseen: {type:Date, required: false},
    vpn_udp_ip : {type:String, required: true, unique: true},
    vpn_tcp_ip : {type:String, required: true, unique: true},
    vpn_mask : {type:String, required: true, unique: false},
    vpn_connections : {type:Number, default : 0},
    vpn_auth_failures : {type:Number, default : 0},
    vpn_bytes_sent : {type:Number, default : 0},
    vpn_bytes_recv : {type:Number, default : 0},
    vpn_conn_hours : {type:Number, default : 0.0},
    vpn_last_start: {type:Date},
    vpn_last_end: {type:Date},
    vpn_is_connected : {type:Boolean, default : false},
    inactivity_notif_sent : {type:Boolean, default : false}
});

DeviceSchema.statics.getAllTypes = function() {
    return ['ipad', 'iphone', 'macbook', 'imac', 'android-phone', 'android-tablet', 'windows-laptop', 'windows-pc', 'linux-laptop', 'linux-pc'];
};

DeviceSchema.statics.getAllPlatforms = function() {
    return ['ios', 'darwin', 'linux', 'windows', 'android'];
};

DeviceSchema.statics.type2platform = function(type) {
    switch (type) {
    case 'ipad':
    case 'iphone':
	return 'ios';
	break;
    case 'android-phone':
    case 'android-tablet':
	return 'android';
	break;
    case 'macbook':
    case 'imac':
	return 'darwin';
	break;
    case 'windows-laptop': 
    case 'windows-pc': 
	return 'windows';
	break;
    case 'linux-laptop':
    case 'linux-pc':
	return 'linux';
	break;
    }
    return undefined;
};

DeviceSchema.statics.isMobilePlatform = function(platform) {
    return (platform === 'android' || platform === 'ios');
};

DeviceSchema.pre('validate', function(next) {
    var device = this;
    if (device.isNew) {
	var Device = require('./Device');
	Device
	    .find()
	    .sort('-created')
	    .limit(1)
	    .select('vpn_udp_ip vpn_tcp_ip')
	    .exec(function(err, dev) {    
		if (err) next(err);
		if (dev.length>0) {
		    // next free UDP
		    dev = dev[0]
		    tmp = ip.toLong(dev.vpn_udp_ip);
		    tmp += 1;
		    device.vpn_udp_ip = ip.fromLong(tmp);
		    if (device.vpn_udp_ip > UDP_RANGE_END) // should not happen
			next(new Error('Run out of UDP addresses'));

		    // next free TCP
		    tmp = ip.toLong(dev.vpn_tcp_ip);
		    tmp += 1;
		    device.vpn_tcp_ip = ip.fromLong(tmp);
		    if (device.vpn_tcp_ip > TCP_RANGE_END) // should not happen
			next(new Error('Run out of TCP addresses'));
		} else {
		    device.vpn_tcp_ip = TCP_RANGE_START;
		    device.vpn_udp_ip = UDP_RANGE_START;
		}
		device.vpn_mask = '255.255.0.0'
		debug(JSON.stringify(device));
		next();
	    });
    } else {
	next();
    }
});

/** Avg connection duration in minutes. */
DeviceSchema.virtual('vpn_avg_duration').get(function () {
    if (this.vpn_connections > 0 && !this.vpn_is_connected)
	return (this.vpn_conn_hours * 60.0 / this.vpn_connections).toFixed(2);
    else if (this.vpn_connections > 1 && this.vpn_is_connected)
	return (this.vpn_conn_hours * 60.0 / (this.vpn_connections - 1).toFixed(2));
    else
	return 0.0;
});

/** Email notif sent. */
DeviceSchema.methods.setnotif = function(cb) {
    this.inactivity_notif_sent = true;
    this.save(cb);
};

/** Reset email notif flag. */
DeviceSchema.methods.unsetnotif = function(cb) {
    this.inactivity_notif_sent = false;
    this.save(cb);
};

DeviceSchema.methods.updateapp = function(uuid, cb) {
    if (uuid)
	this.app_uuid = uuid;
    this.app_lastseen = Date.now();
    this.save(cb);
};

DeviceSchema.virtual('platform').get(function() {
    return this.type2platform(this.type);
});

DeviceSchema.virtual('vpn_conn_hours_fmt').get(function() {
    return (this.vpn_conn_hours).toFixed(2);
});

DeviceSchema.virtual('vpn_bytes_sent_mb').get(function() {
    return (this.vpn_bytes_sent / (1024.0 * 1024.0)).toFixed(2);
});

DeviceSchema.virtual('vpn_bytes_recv_mb').get(function() {
    return (this.vpn_bytes_recv / (1024.0 * 1024.0)).toFixed(2);
});

DeviceSchema.virtual('vpn_lastconn_start').get(function() {
    if (this.vpn_last_start)
	return moment(this.vpn_last_start).format("MMM Do, HH:mm");
    else
	return "--";
});

DeviceSchema.virtual('vpn_lastconn_end').get(function() {
    if (this.vpn_is_connected) 
	return "Connected " + moment(this.vpn_last_start).fromNow();
    else if (this.vpn_last_end)
	return moment(this.vpn_last_end).format("MMM Do, HH:mm");
    else
	return "--";
});

/** Device list. */
DeviceSchema.statics.findDevicesForUser = function(username, cb) {
    require('./Device').find({username : username}, cb);
};

/** All devices list. */
DeviceSchema.statics.findAllDevices = function(cb) {
    require('./Device').find({}, cb);
};

/** Get devices summary. */
DeviceSchema.statics.findDeviceStatsForUser = function(username, cb) {
    require('./Device').find({username : username}, function(err, devices) {
	if (err) cb(err, null);

	var res = {};
	res['count'] = 0;
	res['vpn_conn_succ'] = 0;
	res['vpn_conn_fail'] = 0;
	res['vpn_conn_active'] = 0;

	for (var i = 0; i < devices.length; i++) {	    
	    var d = devices[i];
	    if (d.removed!==undefined)
		continue;

	    res['count'] += 1;
	    res['vpn_conn_succ'] += d.vpn_connections;
	    res['vpn_conn_fail'] += d.vpn_auth_failures;
	    if (d.vpn_is_connected) {
		res['vpn_conn_active'] += 1;
	    }
	}
	cb(null, res);
    });
};

var model = db.model('Device', DeviceSchema);
exports = module.exports = model;

