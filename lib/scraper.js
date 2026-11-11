import PromiseQueue from 'p-queue';
import logger from './logger.js';
import defaults from './config/defaults.js';
import recursiveSources from './config/recursive-sources.js';
import Resource from './resource.js';
import request from './request.js';
import ResourceHandler from './resource-handler/index.js';
import {
	SaveResourceToFileSystemPlugin,
	GenerateFilenameBySiteStructurePlugin,
	GenerateFilenameByTypePlugin,
	GetResourceReferencePlugin
} from './plugins/index.js';

import * as utils from './utils/index.js';
const { extend, union, urlsEqual, getTypeByMime, getTypeByFilename, series } = utils;
import NormalizedUrlMap from './utils/normalized-url-map.js';

const actionNames = [
	'beforeStart', 'afterFinish', 'error',
	'beforeRequest', 'afterResponse',
	'onResourceSaved', 'onResourceError',
	'generateFilename',
	'getReference',
	'saveResource',
	'removeResource',
];

const mandatoryActions = [
	{ name: 'saveResource', pluginClass: SaveResourceToFileSystemPlugin },
	{ name: 'generateFilename', pluginClass: GenerateFilenameByTypePlugin },
	{ name: 'getReference', pluginClass: GetResourceReferencePlugin },
];

const filenameGeneratorPlugins = {
	byType: GenerateFilenameByTypePlugin,
	bySiteStructure: GenerateFilenameBySiteStructurePlugin
};

class Scraper {
	constructor (options) {
		this.normalizeOptions(options);
		logger.info('init with options', this.options);

		this.resourceHandler = new ResourceHandler(this.options, {
			requestResource: this.requestResource.bind(this),
			getReference: this.getReference.bind(this)
		});
		this.resources = this.options.urls.map(({url, filename}) => new Resource(url, filename));

		this.requestedResourcePromises = new NormalizedUrlMap(); // Map url -> request promise
		this.loadedResources = new NormalizedUrlMap(); // Map url -> resource
		this.requestQueue = new PromiseQueue({concurrency: this.options.requestConcurrency});
		this.pendingNotifications = new Set();
		this.notificationError = null; // first error from onResourceSaved which should fail scraping

		// Reliable references state (used when reliableReferences is enabled)
		this.reliableOutcomes = new Map(); // Map resource -> 'saved' | 'failed'
		this.reliableAttempted = new Set(); // resources which were already saved once (never retry)
		this.reliableOriginals = new Map(); // Map resource -> text/url/encoding before resource handling
	}

	normalizeOptions (options) {
		this.options = extend(defaults, options);
		this.options.request = extend(defaults.request, options.request);

		const urls = Array.isArray(options.urls) ? options.urls : [options.urls];

		this.options.urls = urls.map((urlItem) => {
			if (typeof urlItem === 'string') {
				return { url: urlItem, filename: this.options.defaultFilename };
			} else {
				return {url: urlItem.url, filename: urlItem.filename || this.options.defaultFilename};
			}
		});

		if (this.options.subdirectories) {
			this.options.subdirectories.forEach((element) => {
				element.extensions = element.extensions.map((ext) => ext.toLowerCase());
			});
		}

		this.options.recursiveSources = recursiveSources;
		if (this.options.recursive) {
			this.options.sources = union(this.options.sources, this.options.recursiveSources);
		}

		this.options.plugins = this.options.plugins || [];

		if (Object.keys(filenameGeneratorPlugins).includes(this.options.filenameGenerator)) {
			this.options.plugins.unshift(new filenameGeneratorPlugins[this.options.filenameGenerator]());
		}

		this.reliableReferences = Boolean(this.options.reliableReferences);
		this.reliableSaving = this.reliableReferences && Boolean(this.options.ignoreErrors);

		this.applyPlugins(this.options.plugins);
		this.validateReliableReferences();
	}

	applyPlugins (plugins = []) {
		this.actions = {};
		this.actionPlugins = {};
		actionNames.forEach(actionName => {
			this.actions[actionName] = [];
			this.actionPlugins[actionName] = [];
		});
		plugins.forEach(plugin => {
			logger.debug(`[plugin] apply plugin ${plugin.constructor.name}`);
			plugin.apply((name, handler) => this.addAction(name, handler, plugin));
		});

		mandatoryActions.forEach(mandatoryAction => {
			if (this.actions[mandatoryAction.name].length === 0) {
				const plugin = new mandatoryAction.pluginClass();
				logger.debug(`[plugin] apply default plugin ${plugin.constructor.name} for action ${mandatoryAction.name}`);
				plugin.apply((name, handler) => this.addAction(name, handler, plugin));
			}
		});
	}

	addAction (name, handler, plugin) {
		if (!actionNames.includes(name)) {
			throw new Error(`Unknown action "${name}"`);
		}
		logger.debug(`add action ${name}`);
		this.actions[name].push(handler);
		this.actionPlugins[name].push(plugin || null);
	}

	loadResource (resource) {
		const url = resource.getUrl();

		if (this.loadedResources.has(url)) {
			logger.debug('found loaded resource for ' + resource);
		} else {
			logger.debug('add loaded resource ' + resource);
			this.loadedResources.set(url, resource);
		}
	}

	async getReference (params) {
		const result = await this.runActions('getReference', params);

		if (!this.reliableReferences) {
			return result;
		}

		return this.resolveReliableReference(result, params);
	}

	/**
	 * In reliable references mode a local reference is allowed only for resources which
	 * were finally saved. Everything else falls back to the absolute url resolved from
	 * the effective base url of the parent resource (fragment is preserved).
	 */
	resolveReliableReference (result, {resource, parentResource, originalReference}) {
		if (resource && this.reliableOutcomes.get(resource) !== 'failed') {
			return result;
		}

		const reference = utils.getUrl(parentResource.getUrl(), originalReference);
		return {reference, reliableFallback: true};
	}

	async saveResource (resource) {
		if (this.reliableSaving) {
			await this.saveResourceReliable(resource);
			return;
		}

		resource.setSaved();

		try {
			await this.resourceHandler.handleResource(resource);
			logger.info('saving resource ' + resource + ' to fs');
			await this.runActions('saveResource', {resource});
			this.notify('onResourceSaved', {resource}, (err) => this.handleNotificationError(err, resource));
		} catch (err) {
			logger.warn('failed to save resource ' + resource);
			await this.handleError(err, resource);
		}
	}

	async saveResourceReliable (resource) {
		if (this.reliableAttempted.has(resource)) {
			return;
		}

		this.reliableAttempted.add(resource);
		resource.setSaved();
		this.snapshotReliableResource(resource);

		try {
			await this.resourceHandler.handleResource(resource);
			logger.info('saving resource ' + resource + ' to fs');
			await this.runActions('saveResource', {resource});
			this.reliableOutcomes.set(resource, 'saved');
		} catch (err) {
			logger.warn('failed to save resource ' + resource);
			await this.handleReliableFailure(err, resource);
		}
	}

	async handleReliableFailure (err, resource) {
		this.reliableOutcomes.set(resource, 'failed');
		await this.handleError(err, resource);

		// A failed resource must not leave a partial file behind. Cleanup failure is fatal
		// even when ignoreErrors is true, because mirrored references cannot be trusted then.
		await this.removeReliableResourceFile(resource);
	}

	async removeReliableResourceFile (resource) {
		await this.runActions('removeResource', {resource});
	}

	snapshotReliableResource (resource) {
		// Only html and css resources are parsed and can contain references.
		if (!(resource.isHtml() || resource.isCss()) || this.reliableOriginals.has(resource)) {
			return;
		}

		this.reliableOriginals.set(resource, {
			text: resource.getText(),
			url: resource.getUrl(),
			encoding: resource.getEncoding()
		});
	}

	restoreReliableResource (resource) {
		const original = this.reliableOriginals.get(resource);
		if (!original) {
			return false;
		}

		resource.setText(original.text);
		resource.setUrl(original.url);
		resource.setEncoding(original.encoding);
		return true;
	}

	async saveLoadedResourcesReliable () {
		let resourcesToSave = this.getResourcesToSave();

		while (resourcesToSave.length > 0) {
			const promises = resourcesToSave.map(resource => () => this.saveResourceReliable(resource));
			await series(promises);
			resourcesToSave = this.getResourcesToSave();
		}
	}

	getResourcesToSave () {
		return Array.from(this.loadedResources.values()).filter(resource => !resource.isSaved());
	}

	/**
	 * Rewrite references to resources which failed to save. Rewriting may itself fail;
	 * such resource is then treated as failed too and its own inbound references are
	 * fixed on the next iteration. Requests are served from the request cache, so
	 * correction never downloads anything again.
	 */
	async stabilizeReliableReferences () {
		let changed = true;

		while (changed) {
			changed = false;
			const hasFailedResources = Array.from(this.reliableOutcomes.values()).some((outcome) => outcome === 'failed');

			if (!hasFailedResources) {
				break;
			}

			for (const resource of this.loadedResources.values()) {
				if (this.reliableOutcomes.get(resource) !== 'saved') {
					continue;
				}

				if (await this.correctReliableResource(resource)) {
					changed = true;
				}
			}
		}
	}

	async correctReliableResource (resource) {
		if (!this.reliableOriginals.has(resource)) {
			return false;
		}

		const savedText = resource.getText();

		this.restoreReliableResource(resource);

		try {
			await this.resourceHandler.handleResource(resource);

			if (resource.getText() === savedText) {
				return false;
			}

			logger.info('saving corrected resource ' + resource + ' to fs');
			await this.runActions('saveResource', {resource});
			return true;
		} catch (err) {
			logger.warn('failed to save corrected resource ' + resource);
			await this.handleReliableFailure(err, resource);
			return true;
		}
	}

	sendReliableNotifications () {
		const notified = new Set();

		for (const resource of this.loadedResources.values()) {
			if (this.reliableOutcomes.get(resource) !== 'saved' || notified.has(resource)) {
				continue;
			}

			notified.add(resource);
			this.notify('onResourceSaved', {resource}, (err) => this.handleNotificationError(err, resource));
		}
	}

	createNewRequest (resource) {
		const self = this;
		const url = resource.getUrl();

		const requestPromise = Promise.resolve()
			.then(async () => {
				const referer = resource.parent ? resource.parent.getUrl() : null;
				return this.requestQueue.add(async () => {
					const {requestOptions} = await this.runActions('beforeRequest', {resource, requestOptions: this.options.request});
					return request.get({
						url,
						referer,
						options: requestOptions,
						afterResponse: this.actions.afterResponse.length ? this.runActions.bind(this, 'afterResponse') : undefined
					});
				});
			}).then(async function requestCompleted (responseData) {
				if (!responseData) {
					logger.debug('no response returned for url ' + url);
					return null;
				}

				if (!urlsEqual(responseData.url, url)) { // Url may be changed in redirects
					logger.debug('url changed. old url = ' + url + ', new url = ' + responseData.url);

					if (self.requestedResourcePromises.has(responseData.url)) {
						return self.requestedResourcePromises.get(responseData.url);
					}

					resource.setUrl(responseData.url);
					self.requestedResourcePromises.set(responseData.url, requestPromise);
				}

				resource.setType(getTypeByMime(responseData.mimeType));

				const { filename } = await self.runActions('generateFilename', { resource, responseData });
				resource.setFilename(filename);

				// if type was not determined by mime we can try to get it from filename after it was generated
				if (!resource.getType()) {
					resource.setType(getTypeByFilename(filename));
				}

				if (responseData.metadata) {
					resource.setMetadata(responseData.metadata);
				}

				resource.setEncoding(responseData.encoding);
				resource.setText(responseData.body);

				self.loadResource(resource); // Add resource to list for future downloading, see Scraper.waitForLoad
				return resource;
			}).catch(function handleError (err) {
				logger.error('failed to request resource ' + resource);
				return self.handleError(err, resource);
			});

		self.requestedResourcePromises.set(url, requestPromise);
		return requestPromise;
	}

	async requestResource (resource) {
		const url = resource.getUrl();
		const depth = resource.getDepth();

		if (this.options.urlFilter && depth > 0 && !this.options.urlFilter(url)) {
			logger.debug('filtering out ' + resource + ' by url filter');
			return null;
		}

		if (this.options.maxDepth && depth > this.options.maxDepth) {
			logger.debug('filtering out ' + resource + ' by depth');
			return null;
		}

		if (this.requestedResourcePromises.has(url)) {
			logger.debug('found requested resource for ' + resource);
			return this.requestedResourcePromises.get(url);
		}

		return this.createNewRequest(resource);
	}

	async runActions (actionName, params) {
		logger.debug(`run ${this.actions[actionName].length} actions ${actionName}`);

		let result = extend(params);
		for (let action of this.actions[actionName]) {
			if (typeof action === 'function') {
				result = await action(extend(params, result));
			}
		}
		return result;
	}

	async load () {
		const loadResourcePromises = this.resources.map(
			resource => this.requestResource.bind(this, resource)
		);
		await series(loadResourcePromises);

		if (this.reliableSaving) {
			await this.saveLoadedResourcesReliable();
			await this.stabilizeReliableReferences();
			this.sendReliableNotifications();
			return this.resources;
		}

		return this.waitForLoad();
	}

	// Returns a promise which gets resolved when all resources are loaded.
	// 1. Get all not saved resources and save them
	// 2. Recursion if any new not saved resource were added during this time. If not, loading is done.
	async waitForLoad () {
		const resourcesToSave = Array.from(this.loadedResources.values()).filter((r) => !r.isSaved());
		const loadingIsFinished = resourcesToSave.length === 0;

		if (!loadingIsFinished) {
			const saveResourcePromises = resourcesToSave.map(
				resource => this.saveResource.bind(this, resource)
			);
			await series(saveResourcePromises);
			return this.waitForLoad();
		}
		logger.info('downloading is finished successfully');
		return Promise.resolve(this.resources);
	}

	async handleError (err, resource) {
		this.notify('onResourceError', {resource, error: err});

		if (this.options.ignoreErrors) {
			logger.warn('ignoring error: ' + err.message);
			return null;
		}

		logger.error('error occurred: ' + err.message);
		throw err;
	}

	// Notifies external code without blocking scraping. scrape() waits for these before afterFinish.
	// Errors are passed to onError if provided, otherwise only logged.
	notify (actionName, params, onError) {
		const promise = this.runActions(actionName, params)
			.catch((err) => {
				logger.warn(`${actionName} action failed`, err);
				return onError ? onError(err) : null;
			})
			.finally(() => this.pendingNotifications.delete(promise));
		this.pendingNotifications.add(promise);
	}

	// onResourceSaved failure is handled as any other resource error: onResourceError is called,
	// and if ignoreErrors = false scrape() is rejected once pending notifications are finished
	async handleNotificationError (err, resource) {
		const error = err instanceof Error ? err : new Error(`onResourceSaved action failed for ${resource}: ${err}`);
		try {
			await this.handleError(error, resource);
		} catch (e) {
			this.notificationError = this.notificationError || e;
		}
	}

	async waitForNotifications () {
		while (this.pendingNotifications.size > 0) {
			await Promise.all(this.pendingNotifications);
		}
	}

	validateReliableReferences () {
		if (!this.reliableReferences) {
			return;
		}

		const saveResourcePlugins = this.actionPlugins.saveResource;
		const getReferencePlugins = this.actionPlugins.getReference;
		const usesOnlyBuiltInSaveResource = saveResourcePlugins.length === 1 &&
			Boolean(saveResourcePlugins[0]) &&
			saveResourcePlugins[0].constructor === SaveResourceToFileSystemPlugin;
		const usesOnlyBuiltInGetReference = getReferencePlugins.length === 1 &&
			Boolean(getReferencePlugins[0]) &&
			getReferencePlugins[0].constructor === GetResourceReferencePlugin;

		if (!usesOnlyBuiltInSaveResource || !usesOnlyBuiltInGetReference) {
			throw new Error(
				'Option "reliableReferences" requires the built-in "saveResource" and "getReference" plugins. ' +
				'Custom plugins replacing either of them are not supported.'
			);
		}
	}

	async scrape () {
		// Validate before any request or file system operation is performed.
		this.validateReliableReferences();

		try {
			await this.runActions('beforeStart', {options: this.options, utils});
			const resources = await this.load();
			await this.waitForNotifications();
			if (this.notificationError) {
				throw this.notificationError;
			}
			return resources;
		} catch (error) {
			logger.error('finishing with error: ' + error.message);
			await this.runActions('error', {error});
			throw error;
		} finally {
			await this.waitForNotifications();
			await this.runActions('afterFinish');
		}
	}
}

export default Scraper;
