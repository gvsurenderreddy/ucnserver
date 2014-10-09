var express = require('express');
var router = express.Router();

/** Handle main page request. */
router.all('/', function(req, res, next) {
    return res.render('index', {
	locale_fr : (req.cookies.ucnlang === 'fr' ? true : false),
	loggedin : false,
	partials : { header : 'header', footer : 'footer'}
    });
});

module.exports = router;
