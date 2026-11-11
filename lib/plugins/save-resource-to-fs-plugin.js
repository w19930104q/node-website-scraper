import path from 'path';
import fs from 'fs';
import { outputFile } from '../utils/fs.js';

class SaveResourceToFileSystemPlugin {
	apply (registerAction) {
		let absoluteDirectoryPath, loadedResources = [];

		registerAction('beforeStart', ({options}) => {
			if (!options.directory || typeof options.directory !== 'string') {
				throw new Error(`Incorrect directory ${options.directory}`);
			}

			absoluteDirectoryPath = path.resolve(process.cwd(), options.directory);

			if (fs.existsSync(absoluteDirectoryPath)) {
				throw new Error(`Directory ${absoluteDirectoryPath} exists`);
			}
		});

		registerAction('saveResource', async ({resource}) => {
			const filename = path.join(absoluteDirectoryPath, resource.getFilename());
			const text = resource.getText();
			await outputFile(filename, text, resource.getEncoding());
			loadedResources.push(resource);
		});

		registerAction('removeResource', async ({resource}) => {
			if (!resource.getFilename()) {
				return;
			}
			const filename = path.join(absoluteDirectoryPath, resource.getFilename());
			await fs.promises.rm(filename, {force: true});
		});

		registerAction('error', async () => {
			if (loadedResources.length > 0) {
				await fs.promises.rm(absoluteDirectoryPath, {force: true, recursive: true});
			}
		});
	}
}

export default SaveResourceToFileSystemPlugin;
