import * as chai from 'chai';
chai.should();

import '../../utils/assertions.js';
import nock from 'nock';
import fs from 'fs';
import sinon from 'sinon';
import scrape from 'website-scraper';
import Scraper from '../../../lib/scraper.js';

const testDirname = './test/functional/reliable-references/.tmp';

const htmlHeaders = {'content-type': 'text/html'};
const cssHeaders = {'content-type': 'text/css'};

function createNotificationsPlugin (notifications) {
	return {
		apply (addAction) {
			addAction('onResourceSaved', ({resource}) => notifications.saved.push(resource.getFilename()));
			addAction('onResourceError', ({resource}) => notifications.errors.push(resource.getUrl()));
		}
	};
}

describe('Functional: reliable references', function() {
	let notifications;

	const defaultOptions = {
		urls: [ 'http://example.com/' ],
		directory: testDirname,
		subdirectories: null,
		ignoreErrors: true,
		reliableReferences: true
	};

	beforeEach(function() {
		nock.cleanAll();
		nock.disableNetConnect();
		notifications = { saved: [], errors: [] };
	});

	afterEach(function() {
		sinon.restore();
		nock.cleanAll();
		nock.enableNetConnect();
		fs.rmSync(testDirname, {recursive: true, force: true});
	});

	function scrapeWithNotifications (options) {
		return scrape({
			...options,
			plugins: [ createNotificationsPlugin(notifications) ]
		});
	}

	function stubWriteFileFailures (shouldFail) {
		const originalWriteFile = fs.promises.writeFile;
		sinon.stub(fs.promises, 'writeFile').callsFake(async function(file, ...args) {
			if (shouldFail(String(file))) {
				throw new Error(`WRITE FAILED for ${file}`);
			}
			return originalWriteFile(file, ...args);
		});
	}

	it('should keep local paths for saved resources and use absolute urls for others', async function() {
		nock('http://example.com/').get('/').reply(200, `
			<html>
				<head><link rel="stylesheet" href="style.css"></head>
				<body>
					<img src="ok.png">
					<img src="broken.png">
					<img src="fragment.png#hash">
					<img srcset="ok.png 1x, broken.png 2x">
				</body>
			</html>`, htmlHeaders);
		nock('http://example.com/').get('/ok.png').reply(200, 'OK');
		nock('http://example.com/').get('/broken.png').replyWithError('BROKEN');
		nock('http://example.com/').get('/fragment.png').replyWithError('BROKEN');
		nock('http://example.com/').get('/style.css').reply(200,
			`body { background: url('missing.png'); } .a { background: url('ok.png'); }`, cssHeaders);
		nock('http://example.com/').get('/missing.png').replyWithError('BROKEN');

		await scrapeWithNotifications(defaultOptions);

		const index = fs.readFileSync(testDirname + '/index.html').toString();
		index.should.contain('src="ok.png"');
		index.should.contain('src="http://example.com/broken.png"');
		index.should.contain('src="http://example.com/fragment.png#hash"');
		index.should.contain('ok.png 1x');
		index.should.contain('http://example.com/broken.png 2x');
		index.should.contain('href="style.css"');

		const css = fs.readFileSync(testDirname + '/style.css').toString();
		css.should.contain('url(\'http://example.com/missing.png\')');
		css.should.contain('url(\'ok.png\')');

		fs.existsSync(testDirname + '/ok.png').should.be.eql(true);
		fs.existsSync(testDirname + '/style.css').should.be.eql(true);
		fs.existsSync(testDirname + '/broken.png').should.be.eql(false);
		fs.existsSync(testDirname + '/fragment.png').should.be.eql(false);
		fs.existsSync(testDirname + '/missing.png').should.be.eql(false);

		notifications.saved.sort().should.eql(['index.html', 'ok.png', 'style.css']);
		notifications.errors.sort().should.eql([
			'http://example.com/broken.png',
			'http://example.com/fragment.png#hash',
			'http://example.com/missing.png'
		]);
	});

	it('should keep references consistent for circular dependencies when one resource fails to save', async function() {
		let aRequestsCount = 0;
		let bRequestsCount = 0;
		nock('http://example.com/').get('/a.html').reply(200, () => {
			aRequestsCount++;
			return '<a href="b.html">b</a>';
		}, htmlHeaders);
		nock('http://example.com/').get('/b.html').reply(200, () => {
			bRequestsCount++;
			return '<a href="a.html">a</a>';
		}, htmlHeaders);

		stubWriteFileFailures((file) => file.endsWith('b.html'));

		await scrapeWithNotifications({
			...defaultOptions,
			urls: [ {url: 'http://example.com/a.html', filename: 'a.html'} ],
			recursive: true
		});

		// resources are not re-fetched because of correction
		aRequestsCount.should.be.eql(1);
		bRequestsCount.should.be.eql(1);

		fs.existsSync(testDirname + '/a.html').should.be.eql(true);
		fs.existsSync(testDirname + '/b.html').should.be.eql(false);

		const a = fs.readFileSync(testDirname + '/a.html').toString();
		a.should.contain('href="http://example.com/b.html"');

		notifications.saved.should.eql(['a.html']);
		notifications.errors.should.eql(['http://example.com/b.html']);
	});

	it('should correct all parents sharing a resource which failed to save', async function() {
		let sharedRequestsCount = 0;
		nock('http://example.com/').get('/').reply(200, `
			<html>
				<head><link rel="stylesheet" href="style.css"></head>
				<body><a href="p1.html">p1</a><a href="p2.html">p2</a></body>
			</html>`, htmlHeaders);
		nock('http://example.com/').get('/p1.html').reply(200, '<img src="shared.png">', htmlHeaders);
		nock('http://example.com/').get('/p2.html').reply(200, '<img src="shared.png">', htmlHeaders);
		nock('http://example.com/').get('/style.css').reply(200,
			`body { background: url('shared.png'); }`, cssHeaders);
		nock('http://example.com/').get('/shared.png').reply(200, () => {
			sharedRequestsCount++;
			return 'SHARED';
		});

		stubWriteFileFailures((file) => file.endsWith('shared.png'));

		await scrapeWithNotifications({
			...defaultOptions,
			recursive: true
		});

		// shared resource is requested only once though it has multiple parents
		sharedRequestsCount.should.be.eql(1);

		fs.readFileSync(testDirname + '/p1.html').toString().should.contain('src="http://example.com/shared.png"');
		fs.readFileSync(testDirname + '/p2.html').toString().should.contain('src="http://example.com/shared.png"');
		fs.readFileSync(testDirname + '/style.css').toString().should.contain('url(\'http://example.com/shared.png\')');
		fs.existsSync(testDirname + '/shared.png').should.be.eql(false);

		notifications.saved.sort().should.eql(['index.html', 'p1.html', 'p2.html', 'style.css']);
		notifications.errors.should.eql(['http://example.com/shared.png']);
	});

	it('should handle redirect aliases consistently without re-fetching', async function() {
		let redirectedRequestsCount = 0;
		nock('http://example.com/').get('/').reply(200,
			'<a href="p1.html">p1</a><a href="p2.html">p2</a>', htmlHeaders);
		nock('http://example.com/').get('/p1.html').reply(200, '<img src="old.png">', htmlHeaders);
		nock('http://example.com/').get('/p2.html').reply(200, '<img src="new.png">', htmlHeaders);
		nock('http://example.com/').get('/old.png').reply(302, '', {location: 'http://example.com/new.png'});
		nock('http://example.com/').get('/new.png').reply(200, () => {
			redirectedRequestsCount++;
			return 'IMG';
		});

		stubWriteFileFailures((file) => file.endsWith('new.png'));

		await scrapeWithNotifications({
			...defaultOptions,
			recursive: true
		});

		// both aliases point to the same resource, it is fetched only once
		redirectedRequestsCount.should.be.eql(1);

		fs.readFileSync(testDirname + '/p1.html').toString().should.contain('src="http://example.com/old.png"');
		fs.readFileSync(testDirname + '/p2.html').toString().should.contain('src="http://example.com/new.png"');
		fs.existsSync(testDirname + '/new.png').should.be.eql(false);

		notifications.saved.sort().should.eql(['index.html', 'p1.html', 'p2.html']);
		notifications.errors.should.eql(['http://example.com/new.png']);
	});

	it('should use absolute urls for resources filtered out by urlFilter', async function() {
		nock('http://example.com/').get('/').reply(200,
			'<img src="ok.png"><img src="filtered.png">', htmlHeaders);
		nock('http://example.com/').get('/ok.png').reply(200, 'OK');

		await scrapeWithNotifications({
			...defaultOptions,
			urlFilter: (url) => !url.includes('filtered.png')
		});

		const index = fs.readFileSync(testDirname + '/index.html').toString();
		index.should.contain('src="ok.png"');
		index.should.contain('src="http://example.com/filtered.png"');

		fs.existsSync(testDirname + '/filtered.png').should.be.eql(false);
		notifications.saved.sort().should.eql(['index.html', 'ok.png']);
		notifications.errors.should.eql([]);
	});

	it('should fix references to resources which failed to be parsed', async function() {
		nock('http://example.com/').get('/').reply(200, '<a href="page.html">page</a>', htmlHeaders);
		nock('http://example.com/').get('/page.html').reply(200, '<html>page</html>', htmlHeaders);

		const scraper = new Scraper({
			...defaultOptions,
			recursive: true,
			plugins: [ createNotificationsPlugin(notifications) ]
		});

		const originalHandleResource = scraper.resourceHandler.handleResource;
		sinon.stub(scraper.resourceHandler, 'handleResource').callsFake(function(resource) {
			if (resource.getUrl().endsWith('page.html')) {
				return Promise.reject(new Error('PARSE FAILED'));
			}
			return originalHandleResource.apply(this, arguments);
		});

		await scraper.scrape();

		const index = fs.readFileSync(testDirname + '/index.html').toString();
		index.should.contain('href="http://example.com/page.html"');
		fs.existsSync(testDirname + '/page.html').should.be.eql(false);

		notifications.saved.should.eql(['index.html']);
		notifications.errors.should.eql(['http://example.com/page.html']);
	});

	it('should remove leftovers and fix inbound references when corrected save fails', async function() {
		nock('http://example.com/').get('/').reply(200, '<a href="a.html">a</a>', htmlHeaders);
		nock('http://example.com/').get('/a.html').reply(200, '<img src="broken.png">', htmlHeaders);
		nock('http://example.com/').get('/broken.png').reply(200, 'IMG');

		// broken.png never saves; a.html is saved first, but its rewrite after correction fails
		let aHtmlWritesCount = 0;
		stubWriteFileFailures((file) => {
			if (file.endsWith('broken.png')) {
				return true;
			}
			if (file.endsWith('a.html')) {
				aHtmlWritesCount++;
				return aHtmlWritesCount > 1;
			}
			return false;
		});

		await scrapeWithNotifications({
			...defaultOptions,
			recursive: true
		});

		// leftover of a.html (written before correction) is removed
		fs.existsSync(testDirname + '/a.html').should.be.eql(false);
		fs.existsSync(testDirname + '/broken.png').should.be.eql(false);

		const index = fs.readFileSync(testDirname + '/index.html').toString();
		index.should.contain('href="http://example.com/a.html"');

		notifications.saved.should.eql(['index.html']);
		notifications.errors.sort().should.eql([
			'http://example.com/a.html',
			'http://example.com/broken.png'
		]);
	});

	it('should reject if cleanup of a failed resource fails', async function() {
		nock('http://example.com/').get('/').reply(200, '<img src="broken.png">', htmlHeaders);
		nock('http://example.com/').get('/broken.png').reply(200, 'IMG');

		stubWriteFileFailures((file) => file.endsWith('broken.png'));

		const originalRm = fs.promises.rm;
		sinon.stub(fs.promises, 'rm').callsFake(async function(path, ...args) {
			if (String(path).endsWith('broken.png')) {
				throw new Error('CLEANUP FAILED');
			}
			return originalRm(path, ...args);
		});

		let error = null;
		try {
			await scrapeWithNotifications(defaultOptions);
		} catch (err) {
			error = err;
		}

		error.should.be.instanceOf(Error);
		error.message.should.be.eql('CLEANUP FAILED');
	});

	it('should throw before any i/o if saveResource action is replaced by custom plugin', function() {
		class CustomSavePlugin {
			apply (addAction) {
				addAction('saveResource', () => {});
			}
		}

		const scope = nock('http://example.com/').get('/').reply(200, 'OK');

		(() => scrape({
			...defaultOptions,
			plugins: [ new CustomSavePlugin() ]
		})).should.throw(/reliableReferences/);

		// no requests were made and no directory was created
		scope.isDone().should.be.eql(false);
		fs.existsSync(testDirname).should.be.eql(false);
	});

	it('should throw before any i/o if getReference action is replaced by custom plugin', function() {
		class CustomReferencePlugin {
			apply (addAction) {
				addAction('getReference', () => ({reference: 'custom'}));
			}
		}

		const scope = nock('http://example.com/').get('/').reply(200, 'OK');

		(() => scrape({
			...defaultOptions,
			plugins: [ new CustomReferencePlugin() ]
		})).should.throw(/reliableReferences/);

		// no requests were made and no directory was created
		scope.isDone().should.be.eql(false);
		fs.existsSync(testDirname).should.be.eql(false);
	});

	it('should keep failure cleanup semantics when ignoreErrors is false', async function() {
		nock('http://example.com/').get('/').reply(200, '<img src="ok.png">', htmlHeaders);
		nock('http://example.com/').get('/ok.png').reply(200, 'OK');

		stubWriteFileFailures((file) => file.endsWith('ok.png'));

		let error = null;
		try {
			await scrapeWithNotifications({
				...defaultOptions,
				ignoreErrors: false
			});
		} catch (err) {
			error = err;
		}

		error.should.be.instanceOf(Error);
		error.message.should.contain('WRITE FAILED');
		// directory is removed on failure, as in default mode
		fs.existsSync(testDirname).should.be.eql(false);
	});
});
