import * as chai from 'chai';
const should = chai.should();

import '../../utils/assertions.js';
import nock from 'nock';
import fs from 'fs';
import sinon from 'sinon';
import scrape from 'website-scraper';
import Scraper from '../../../lib/scraper.js';

const testDirname = './test/functional/reliable-references/.tmp';

class CallbackPlugin {
	constructor () {
		this.saved = [];
		this.errors = [];
	}

	apply (registerAction) {
		registerAction('onResourceSaved', ({resource}) => {
			this.saved.push(resource.getUrl());
		});
		registerAction('onResourceError', ({resource}) => {
			this.errors.push(resource.getUrl());
		});
	}
}

function uniqueUrls (urls) {
	return Array.from(new Set(urls));
}

function fileContent (filename) {
	return fs.readFileSync(`${testDirname}/${filename}`).toString();
}

function failSaveFor (scraper, shouldFail) {
	const originalSave = scraper.actions.saveResource[0];
	const attempts = new Map();

	scraper.actions.saveResource[0] = async (params) => {
		const url = params.resource.getUrl();
		const count = (attempts.get(url) || 0) + 1;
		attempts.set(url, count);

		if (shouldFail(url, count)) {
			throw new Error(`SAVE FAILED for ${url}`);
		}

		return originalSave(params);
	};

	return attempts;
}

describe('Functional: reliable references', () => {
	beforeEach(() => {
		nock.cleanAll();
		nock.disableNetConnect();
	});

	afterEach(() => {
		nock.cleanAll();
		nock.enableNetConnect();
		fs.rmSync(testDirname, {recursive: true, force: true});
	});

	it('should keep local references for successful resources and notify each saved resource once', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body>
				<a href="/about.html">about</a>
				<img src="/shared.png">
				<link rel="stylesheet" href="/style.css">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/about.html').reply(200, `
			<html><body>
				<a href="/index.html">index</a>
				<img src="/shared.png">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/shared.png').reply(200, 'shared');
		nock('http://example.com/').get('/style.css').reply(200, '@import url("/style2.css");', {'content-type': 'text/css'});
		nock('http://example.com/').get('/style2.css').reply(200, '@import url("/style.css");', {'content-type': 'text/css'});

		const callbacks = new CallbackPlugin();

		const options = {
			urls: [
				{url: 'http://example.com/index.html', filename: 'index.html'},
				{url: 'http://example.com/about.html', filename: 'about.html'}
			],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [
				{selector: 'a', attr: 'href'},
				{selector: 'img', attr: 'src'},
				{selector: 'link[rel="stylesheet"]', attr: 'href'}
			],
			plugins: [callbacks]
		};

		await scrape(options);

		fs.existsSync(`${testDirname}/index.html`).should.be.eql(true);
		fs.existsSync(`${testDirname}/about.html`).should.be.eql(true);
		fs.existsSync(`${testDirname}/shared.png`).should.be.eql(true);
		fs.existsSync(`${testDirname}/style.css`).should.be.eql(true);
		fs.existsSync(`${testDirname}/style2.css`).should.be.eql(true);

		fileContent('index.html').should.contain('<a href="about.html">about</a>');
		fileContent('index.html').should.contain('<img src="shared.png">');
		fileContent('index.html').should.contain('<link rel="stylesheet" href="style.css">');
		fileContent('about.html').should.contain('<a href="index.html">index</a>');
		fileContent('about.html').should.contain('<img src="shared.png">');
		fileContent('style.css').should.contain('url("style2.css")');
		fileContent('style2.css').should.contain('url("style.css")');

		uniqueUrls(callbacks.saved).should.have.members([
			'http://example.com/index.html',
			'http://example.com/about.html',
			'http://example.com/shared.png',
			'http://example.com/style.css',
			'http://example.com/style2.css'
		]);
		callbacks.saved.length.should.be.eql(uniqueUrls(callbacks.saved).length);
		callbacks.errors.should.be.eql([]);
	});

	it('should handle srcset and inner/outer css references using the effective base url', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><head>
				<base href="/sub/">
				<link rel="stylesheet" href="style.css">
				<style>
					.inline { background: url("/ok.png") }
					.inline-missing { background: url("filtered.png#f") }
				</style>
			</head><body>
				<img srcset="/ok.png 1x, /filtered.png#f 2x">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/sub/style.css').reply(200, `
			.external { background: url("/ok.png") }
			.external-missing { background: url("/filtered.png#f") }`, {'content-type': 'text/css'});
		nock('http://example.com/').get('/ok.png').reply(200, 'ok');

		const callbacks = new CallbackPlugin();

		await scrape({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [
				{selector: 'img', attr: 'srcset'},
				{selector: 'link[rel="stylesheet"]', attr: 'href'},
				{selector: 'style'}
			],
			urlFilter: (url) => !url.includes('/filtered.png'),
			plugins: [callbacks]
		});

		fs.existsSync(`${testDirname}/index.html`).should.be.eql(true);
		fs.existsSync(`${testDirname}/style.css`).should.be.eql(true);
		fs.existsSync(`${testDirname}/ok.png`).should.be.eql(true);
		fs.existsSync(`${testDirname}/filtered.png`).should.be.eql(false);

		fileContent('index.html').should.contain('srcset="ok.png 1x, http://example.com/filtered.png#f 2x"');
		fileContent('index.html').should.contain('background: url("ok.png")');
		fileContent('index.html').should.contain('background: url("http://example.com/sub/filtered.png#f")');
		fileContent('style.css').should.contain('background: url("ok.png")');
		fileContent('style.css').should.contain('background: url("http://example.com/filtered.png#f")');

		uniqueUrls(callbacks.saved).should.have.members([
			'http://example.com/sub/',
			'http://example.com/sub/style.css',
			'http://example.com/ok.png'
		]);
		callbacks.saved.length.should.be.eql(uniqueUrls(callbacks.saved).length);
		callbacks.errors.should.be.eql([]);
	});

	it('should fall back to absolute urls for a shared resource which failed to save', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body>
				<img src="/shared.png">
				<img src="/keep.png">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/about.html').reply(200, `
			<html><body><img src="/shared.png"></body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/shared.png').reply(200, 'shared');
		nock('http://example.com/').get('/keep.png').reply(200, 'keep');

		const callbacks = new CallbackPlugin();
		const scraper = new Scraper({
			urls: [
				{url: 'http://example.com/index.html', filename: 'index.html'},
				{url: 'http://example.com/about.html', filename: 'about.html'}
			],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [{selector: 'img', attr: 'src'}],
			plugins: [callbacks]
		});

		failSaveFor(scraper, (url) => url.endsWith('/shared.png'));

		await scraper.scrape();

		fs.existsSync(`${testDirname}/shared.png`).should.be.eql(false);
		fs.existsSync(`${testDirname}/keep.png`).should.be.eql(true);

		fileContent('index.html').should.contain('src="http://example.com/shared.png"');
		fileContent('index.html').should.contain('src="keep.png"');
		fileContent('about.html').should.contain('src="http://example.com/shared.png"');

		uniqueUrls(callbacks.saved).should.have.members([
			'http://example.com/index.html',
			'http://example.com/about.html',
			'http://example.com/keep.png'
		]);
		callbacks.saved.length.should.be.eql(uniqueUrls(callbacks.saved).length);
		callbacks.errors.should.be.eql(['http://example.com/shared.png']);
	});

	it('should resolve redirect aliases consistently and use the original alias for fallback', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body>
				<img src="/alias.png#icon">
				<img src="/real.png">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/about.html').reply(200, `
			<html><body><img src="/alias.png#icon"></body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/alias.png').reply(302, '', {Location: 'http://example.com/real.png'});
		nock('http://example.com/').get('/real.png').reply(200, 'real');

		const callbacks = new CallbackPlugin();
		const scraper = new Scraper({
			urls: [
				{url: 'http://example.com/index.html', filename: 'index.html'},
				{url: 'http://example.com/about.html', filename: 'about.html'}
			],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [{selector: 'img', attr: 'src'}],
			plugins: [callbacks]
		});

		failSaveFor(scraper, (url) => url.endsWith('/real.png'));

		await scraper.scrape();

		fs.existsSync(`${testDirname}/real.png`).should.be.eql(false);

		fileContent('index.html').should.contain('src="http://example.com/alias.png#icon"');
		fileContent('index.html').should.contain('src="http://example.com/real.png"');
		fileContent('about.html').should.contain('src="http://example.com/alias.png#icon"');

		uniqueUrls(callbacks.saved).should.have.members([
			'http://example.com/index.html',
			'http://example.com/about.html'
		]);
		callbacks.saved.length.should.be.eql(uniqueUrls(callbacks.saved).length);
		callbacks.errors.should.be.eql(['http://example.com/real.png']);
	});

	it('should use absolute fallback with fragment for resources rejected by urlFilter', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body>
				<img src="/filtered.png#part">
				<img src="/ok.png">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/ok.png').reply(200, 'ok');

		const callbacks = new CallbackPlugin();

		await scrape({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [{selector: 'img', attr: 'src'}],
			urlFilter: (url) => !url.includes('/filtered.png'),
			plugins: [callbacks]
		});

		fs.existsSync(`${testDirname}/filtered.png`).should.be.eql(false);
		fs.existsSync(`${testDirname}/ok.png`).should.be.eql(true);

		fileContent('index.html').should.contain('src="http://example.com/filtered.png#part"');
		fileContent('index.html').should.contain('src="ok.png"');

		uniqueUrls(callbacks.saved).should.have.members([
			'http://example.com/index.html',
			'http://example.com/ok.png'
		]);
		callbacks.saved.length.should.be.eql(uniqueUrls(callbacks.saved).length);
		callbacks.errors.should.be.eql([]);
	});

	it('should fix references to resources which failed to be parsed', async () => {
		nock('http://example.com/').get('/index.html').reply(200,
			'<html><body><a href="/page.html">page</a></body></html>', {'content-type': 'text/html'});
		nock('http://example.com/').get('/page.html').reply(200,
			'<html><body>page</body></html>', {'content-type': 'text/html'});

		const callbacks = new CallbackPlugin();
		const scraper = new Scraper({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [{selector: 'a', attr: 'href'}],
			plugins: [callbacks]
		});

		const originalHandleResource = scraper.resourceHandler.handleResource;
		sinon.stub(scraper.resourceHandler, 'handleResource').callsFake(function (resource) {
			if (resource.getUrl().endsWith('/page.html')) {
				return Promise.reject(new Error('PARSE FAILED'));
			}
			return originalHandleResource.apply(this, arguments);
		});

		await scraper.scrape();

		fs.existsSync(`${testDirname}/index.html`).should.be.eql(true);
		fs.existsSync(`${testDirname}/page.html`).should.be.eql(false);
		fileContent('index.html').should.contain('href="http://example.com/page.html"');

		uniqueUrls(callbacks.saved).should.be.eql(['http://example.com/index.html']);
		callbacks.errors.should.be.eql(['http://example.com/page.html']);
	});

	it('should fix references to a resource in a cycle when it failed to save', async () => {
		nock('http://example.com/').get('/a.html').reply(200, '<a href="/b.html">b</a>', {'content-type': 'text/html'});
		nock('http://example.com/').get('/b.html').reply(200, '<a href="/a.html">a</a>', {'content-type': 'text/html'});

		const callbacks = new CallbackPlugin();
		const scraper = new Scraper({
			urls: [{url: 'http://example.com/a.html', filename: 'a.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [{selector: 'a', attr: 'href'}],
			plugins: [callbacks]
		});

		failSaveFor(scraper, (url) => url.endsWith('/b.html'));

		await scraper.scrape();

		fs.existsSync(`${testDirname}/a.html`).should.be.eql(true);
		fs.existsSync(`${testDirname}/b.html`).should.be.eql(false);
		fileContent('a.html').should.contain('href="http://example.com/b.html"');

		uniqueUrls(callbacks.saved).should.be.eql(['http://example.com/a.html']);
		callbacks.errors.should.be.eql(['http://example.com/b.html']);
	});

	it('should cascade correction failures, remove leftovers and fix all inbound references', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body>
				<a href="/page-a.html">a</a>
				<img src="/missing.png">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/page-a.html').reply(200, `
			<html><body><img src="/missing.png"></body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/missing.png').reply(200, 'missing');

		const callbacks = new CallbackPlugin();
		const scraper = new Scraper({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [
				{selector: 'a', attr: 'href'},
				{selector: 'img', attr: 'src'}
			],
			plugins: [callbacks]
		});

		failSaveFor(scraper, (url, count) => {
			return url.endsWith('/missing.png') || (url.endsWith('/page-a.html') && count === 2);
		});

		await scraper.scrape();

		fs.existsSync(`${testDirname}/index.html`).should.be.eql(true);
		fs.existsSync(`${testDirname}/page-a.html`).should.be.eql(false);
		fs.existsSync(`${testDirname}/missing.png`).should.be.eql(false);

		fileContent('index.html').should.contain('href="http://example.com/page-a.html"');
		fileContent('index.html').should.contain('src="http://example.com/missing.png"');

		uniqueUrls(callbacks.saved).should.have.members(['http://example.com/index.html']);
		callbacks.saved.length.should.be.eql(1);
		callbacks.errors.should.have.members([
			'http://example.com/missing.png',
			'http://example.com/page-a.html'
		]);
	});

	it('should reject the whole scrape if removing a failed resource fails', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body><img src="/shared.png"></body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/shared.png').reply(200, 'shared');

		const callbacks = new CallbackPlugin();
		const scraper = new Scraper({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: true,
			sources: [{selector: 'img', attr: 'src'}],
			plugins: [callbacks]
		});

		failSaveFor(scraper, (url) => url.endsWith('/shared.png'));
		sinon.stub(scraper, 'removeReliableResourceFile').rejects(new Error('CLEANUP FAILED'));

		let scrapeError;
		try {
			await scraper.scrape();
		} catch (err) {
			scrapeError = err;
		}

		should.exist(scrapeError);
		scrapeError.message.should.be.eql('CLEANUP FAILED');
		fs.existsSync(testDirname).should.be.eql(false);
	});

	it('should keep failure cleanup semantics when ignoreErrors is false', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body><img src="/shared.png"></body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/shared.png').reply(200, 'shared');

		const scraper = new Scraper({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			reliableReferences: true,
			ignoreErrors: false,
			sources: [{selector: 'img', attr: 'src'}]
		});

		failSaveFor(scraper, (url) => url.endsWith('/shared.png'));

		let scrapeError;
		try {
			await scraper.scrape();
		} catch (err) {
			scrapeError = err;
		}

		should.exist(scrapeError);
		scrapeError.message.should.contain('SAVE FAILED');
		fs.existsSync(testDirname).should.be.eql(false);
	});

	it('should keep legacy references when reliableReferences is disabled', async () => {
		nock('http://example.com/').get('/index.html').reply(200, `
			<html><body>
				<img src="/filtered.png#part">
				<img src="/shared.png">
			</body></html>`, {'content-type': 'text/html'});
		nock('http://example.com/').get('/shared.png').reply(200, 'shared');

		const scraper = new Scraper({
			urls: [{url: 'http://example.com/index.html', filename: 'index.html'}],
			directory: testDirname,
			subdirectories: null,
			ignoreErrors: true,
			sources: [{selector: 'img', attr: 'src'}],
			urlFilter: (url) => !url.includes('/filtered.png')
		});

		failSaveFor(scraper, (url) => url.endsWith('/shared.png'));

		await scraper.scrape();

		fileContent('index.html').should.contain('src="/filtered.png#part"');
		fileContent('index.html').should.contain('src="shared.png"');
	});

	describe('plugin restrictions', () => {
		it('should reject before any I/O when saveResource is replaced', async () => {
			nock('http://example.com/').get('/').reply(200, 'OK');

			class CustomSavePlugin {
				apply (registerAction) {
					registerAction('saveResource', sinon.stub().resolves());
				}
			}

			let scrapeError;
			try {
				await scrape({
					urls: ['http://example.com/'],
					directory: testDirname,
					reliableReferences: true,
					ignoreErrors: true,
					plugins: [new CustomSavePlugin()]
				});
			} catch (err) {
				scrapeError = err;
			}

			should.exist(scrapeError);
			scrapeError.message.should.contain('built-in "saveResource" and "getReference" plugins');
			fs.existsSync(testDirname).should.be.eql(false);
			nock.isDone().should.be.eql(false);
		});

		it('should reject before any I/O when getReference is replaced', async () => {
			let referenceActionCalled = false;

			class CustomReferencePlugin {
				apply (registerAction) {
					registerAction('getReference', () => {
						referenceActionCalled = true;
						return {reference: null};
					});
				}
			}

			let scrapeError;
			try {
				await scrape({
					urls: ['http://example.com/'],
					directory: testDirname,
					reliableReferences: true,
					ignoreErrors: true,
					plugins: [new CustomReferencePlugin()]
				});
			} catch (err) {
				scrapeError = err;
			}

			should.exist(scrapeError);
			scrapeError.message.should.contain('built-in "saveResource" and "getReference" plugins');
			referenceActionCalled.should.be.eql(false);
			fs.existsSync(testDirname).should.be.eql(false);
		});
	});
});
