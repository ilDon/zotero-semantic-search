/* global Zotero, Services, Cc, Ci */
var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	let aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1']
		.getService(Ci.amIAddonManagerStartup);
	let manifestURI = Services.io.newURI(rootURI + 'manifest.json');
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		['content', 'semantic-search', rootURI + 'content/'],
	]);
	Services.scriptloader.loadSubScript(rootURI + 'content/main.js');
	await SemanticSearchPlugin.startup({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
	SemanticSearchPlugin.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	SemanticSearchPlugin.onMainWindowUnload(window);
}

async function shutdown() {
	if (typeof SemanticSearchPlugin !== 'undefined') {
		await SemanticSearchPlugin.shutdown();
	}
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}

function uninstall() {}
