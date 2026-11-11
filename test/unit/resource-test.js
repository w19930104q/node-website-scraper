import * as chai from 'chai';
chai.should();
import '../../test/utils/assertions.js';
import Resource from '../../lib/resource.js';

describe('Resource', function() {
	describe('#createChild', function () {
		it('should return Resource', function() {
			const parent = new Resource('http://example.com');
			const child = parent.createChild('http://google.com');
			child.should.be.instanceOf(Resource);
		});

		it('should set correct url and filename', function() {
			const parent = new Resource('http://example.com');
			const child = parent.createChild('http://google.com', 'google.html');
			child.getUrl().should.eql('http://google.com');
			child.getFilename().should.equalFileSystemPath('google.html');
		});

		it('should set parent', function() {
			const parent = new Resource('http://example.com');
			const child = parent.createChild('http://google.com');
			child.parent.should.be.equal(parent);
		});

		it('should set depth', function() {
			const parent = new Resource('http://example.com');
			const child = parent.createChild('http://google.com');
			child.depth.should.eql(1);

			const childOfChild = child.createChild('http://google.com.ua');
			childOfChild.depth.should.eql(2);
		});
	});

	describe('save state', function () {
		it('should not be succeeded or failed by default', function() {
			const resource = new Resource('http://example.com');
			resource.isSaveSucceeded().should.be.eql(false);
			resource.isSaveFailed().should.be.eql(false);
		});

		it('should set save succeeded and reset save failed', function() {
			const resource = new Resource('http://example.com');
			resource.setSaveFailed();
			resource.setSaveSucceeded();
			resource.isSaveSucceeded().should.be.eql(true);
			resource.isSaveFailed().should.be.eql(false);
		});

		it('should set save failed and reset save succeeded', function() {
			const resource = new Resource('http://example.com');
			resource.setSaveSucceeded();
			resource.setSaveFailed();
			resource.isSaveFailed().should.be.eql(true);
			resource.isSaveSucceeded().should.be.eql(false);
		});
	});

	describe('#addReference, #getReferences', function () {
		it('should return empty array if no references were added', function() {
			const resource = new Resource('http://example.com');
			resource.getReferences().should.eql([]);
		});

		it('should return added references', function() {
			const resource = new Resource('http://example.com');
			const reference = {
				resource: new Resource('http://example.com/child.png'),
				originalPath: 'child.png',
				currentPath: 'child.png',
				absoluteUrl: 'http://example.com/child.png'
			};
			resource.addReference(reference);
			resource.getReferences().should.eql([reference]);
		});
	});
});
