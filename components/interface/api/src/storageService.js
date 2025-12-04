import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'avirit-projects'; // Default or env var

export async function uploadFile(filePath, destination) {
    try {
        await storage.bucket(BUCKET_NAME).upload(filePath, {
            destination: destination,
        });
        console.log(`${filePath} uploaded to ${BUCKET_NAME}/${destination}`);
        return `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;
    } catch (error) {
        console.error('Error uploading file:', error);
        throw error;
    }
}

export async function uploadDirectory(dirPath, destinationPrefix) {
    const files = await getFiles(dirPath);
    const uploadPromises = files.map(file => {
        const relativePath = path.relative(dirPath, file);
        const destination = path.join(destinationPrefix, relativePath);
        return uploadFile(file, destination);
    });
    return Promise.all(uploadPromises);
}

async function getFiles(dir) {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map((dirent) => {
        const res = path.resolve(dir, dirent.name);
        return dirent.isDirectory() ? getFiles(res) : res;
    }));
    return Array.prototype.concat(...files);
}

export async function getProjectFiles(projectPrefix) {
    try {
        const bucket = storage.bucket(BUCKET_NAME);
        const [files] = await bucket.getFiles({ prefix: projectPrefix });

        const fileUrls = await Promise.all(files.map(async (file) => {
            if (file.name.endsWith('/')) return null; // Skip directories

            // Generate signed URL
            const [url] = await file.getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + 15 * 60 * 1000, // 15 minutes
            });

            return {
                name: file.name.replace(projectPrefix + '/', ''),
                url: url
            };
        }));

        return fileUrls.filter(f => f !== null);
    } catch (error) {
        console.error('Error getting project files:', error);
        throw error;
    }
}

/**
 * List all projects for a user from GCS
 * @param {string} userId - Optional user ID to filter projects
 * @returns {Promise<Array>} Array of project info objects
 */
export async function listUserProjects(userId = null) {
    try {
        const bucket = storage.bucket(BUCKET_NAME);

        // Get all files with 'projects/' prefix
        const [files] = await bucket.getFiles({
            prefix: 'projects/',
            delimiter: '/'
        });

        // Extract unique project folders
        const projectPaths = new Set();
        files.forEach(file => {
            const parts = file.name.split('/');
            if (parts.length >= 3) {
                // Format: projects/projectId/timestamp/...
                const projectPath = `${parts[1]}/${parts[2]}`;
                projectPaths.add(projectPath);
            }
        });

        // Convert to array and get metadata
        const projects = await Promise.all(
            Array.from(projectPaths).map(async (path) => {
                const [projectId, timestamp] = path.split('/');
                const prefix = `projects/${path}/`;

                // Get file count
                const [projectFiles] = await bucket.getFiles({ prefix });
                const fileCount = projectFiles.filter(f => !f.name.endsWith('/')).length;

                // Parse timestamp to date
                let createdAt;
                try {
                    createdAt = new Date(parseInt(timestamp));
                } catch {
                    createdAt = new Date();
                }

                return {
                    projectId,
                    timestamp,
                    path: path,
                    prefix: prefix,
                    fileCount,
                    createdAt: createdAt.toISOString(),
                    displayName: `${projectId} (${createdAt.toLocaleString()})`
                };
            })
        );

        // Sort by creation date (newest first)
        projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return projects;
    } catch (error) {
        console.error('Error listing user projects:', error);
        throw error;
    }
}

export default {
    uploadFile,
    uploadDirectory,
    getProjectFiles,
    listUserProjects
};
