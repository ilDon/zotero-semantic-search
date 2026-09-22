/* Development only: evaluate JS inside Zotero. Loaded only when the
 * extensions.semantic-search.dev pref is true. NOT part of releases. */
/* global Zotero */
Zotero.Server.Endpoints['/semantic-search/dev/eval'] = function () {};
Zotero.Server.Endpoints['/semantic-search/dev/eval'].prototype = {
	supportedMethods: ['POST'],
	supportedDataTypes: ['text/plain', 'application/json'],
	async init(req) {
		let code = typeof req.data === 'string' ? req.data : req.data.code;
		try {
			let AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
			let result = await new AsyncFunction('Zotero', code)(Zotero);
			return [200, 'application/json', JSON.stringify({ ok: true, result }, null, 1)];
		}
		catch (e) {
			return [200, 'application/json', JSON.stringify({ ok: false, error: String(e), stack: e.stack })];
		}
	},
};
