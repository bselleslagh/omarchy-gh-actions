.pragma library

// The service, for widgets the shell will not hand it to. A widget hosted in a
// tray drawer gets the drawer's bar facade, whose serviceFor() does not answer
// for this plugin. `.pragma library` makes this one instance per engine, so the
// service and every bar's widget meet here whatever order they load in.
var _service = null

function set(service) { _service = service }
function get() { return _service }

// Only the instance that registered may unregister, so a reloaded service coming
// up before the old one is destroyed is not wiped out by it.
function clear(service) {
  if (_service === service) _service = null
}
