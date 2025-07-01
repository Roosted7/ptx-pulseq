// optimize.js
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');
const terser = require('terser');
const postcss = require('postcss');
const cssnano = require('cssnano');
const cheerio = require('cheerio');
const { minify } = require('html-minifier-terser');

// --- Helper to dynamically import ESM-only imagemin packages ---
async function loadImagemin() {
    // Dynamically import all necessary imagemin modules
    const imagemin = (await import('imagemin')).default;
    const imageminGifsicle = (await import('imagemin-gifsicle')).default;
    const imageminJpegtran = (await import('imagemin-jpegtran')).default;
    const imageminOptipng = (await import('imagemin-optipng')).default;
    const imageminSvgo = (await import('imagemin-svgo')).default;
    const imageminWebp = (await import('imagemin-webp')).default;
    return { imagemin, imageminGifsicle, imageminJpegtran, imageminOptipng, imageminSvgo, imageminWebp };
}

const SITE_DIR = 'site';

// --- Helper to check if a file exists ---
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// --- Optimization Functions ---

async function minifyJs() {
    console.log('--- Minifying JavaScript files ---');
    const jsFiles = await glob(`${SITE_DIR}/**/*.js`);
    for (const file of jsFiles) {
        try {
            const originalContent = await fs.readFile(file, 'utf8');
            const result = await terser.minify(originalContent);

            if (result.error) {
                console.error(`  Terser error in ${file}:`, result.error);
                continue;
            }

            if (result.code.length < originalContent.length) {
                console.log(`  Minifying: ${file} (saved ${originalContent.length - result.code.length} bytes)`);
                await fs.writeFile(file, result.code, 'utf8');
            } else {
                console.log(`  Skipping: ${file} (already optimized)`);
            }
        } catch (err) {
            console.error(`  Error processing JS file ${file}:`, err.message);
        }
    }
}

async function minifyCss() {
    console.log('\n--- Minifying CSS files ---');
    const cssFiles = await glob(`${SITE_DIR}/**/*.css`);
    const processor = postcss([cssnano]);
    for (const file of cssFiles) {
        try {
            const originalContent = await fs.readFile(file, 'utf8');
            const cleanContent = originalContent.replace(/\/\*# sourceMappingURL=.*\*\//g, '');

            const result = await processor.process(cleanContent, { from: undefined });

            if (result.css.length < originalContent.length) {
                 console.log(`  Minifying: ${file} (saved ${originalContent.length - result.css.length} bytes)`);
                await fs.writeFile(file, result.css, 'utf8');
            } else {
                console.log(`  Skipping: ${file} (already optimized)`);
            }
        } catch (err) {
            console.error(`  Error processing CSS file ${file}: ${err.message}`);
        }
    }
}

async function optimizeImages(imageminTools) {
    const { imagemin, imageminGifsicle, imageminJpegtran, imageminOptipng, imageminSvgo, imageminWebp } = imageminTools;
    const imageFiles = await glob(`${SITE_DIR}/**/*.{jpg,jpeg,png,gif,svg}`);

    console.log('\n--- Optimizing Images (Lossless) & Generating WebP ---');

    for (const file of imageFiles) {
        try {
            const originalBuffer = await fs.readFile(file);

            // 1. Perform lossless optimization
            const optimizedBuffer = await imagemin.buffer(originalBuffer, {
                plugins: [
                    imageminGifsicle({ interlaced: true }),
                    imageminJpegtran({ progressive: true }),
                    imageminOptipng({ optimizationLevel: 7 }),
                    imageminSvgo()
                ]
            });

            if (optimizedBuffer.length < originalBuffer.length) {
                console.log(`  Optimizing: ${file} (saved ${originalBuffer.length - optimizedBuffer.length} bytes)`);
                await fs.writeFile(file, optimizedBuffer);
            } else {
                console.log(`  Skipping: ${file} (already optimized)`);
            }

            // 2. Generate WebP version (for PNG and JPG only)
            if (/\.(jpe?g|png)$/i.test(file)) {
                const webpBuffer = await imagemin.buffer(originalBuffer, {
                    plugins: [imageminWebp({ quality: 75 })]
                });
                const webpPath = file.replace(/\.(jpe?g|png)$/i, '.webp');
                await fs.writeFile(webpPath, webpBuffer);
            }
        } catch (err) {
            console.error(`  Error optimizing image ${file}:`, err.message);
        }
    }
}


async function processHtml() {
    console.log('\n--- Processing HTML files ---');
    const htmlFiles = await glob(`${SITE_DIR}/**/*.html`);
    for (const file of htmlFiles) {
        try {
            let content = await fs.readFile(file, 'utf8');
            const $ = cheerio.load(content);

            const imagePromises = [];
            $('img').each((i, el) => {
                const img = $(el);
                const originalSrc = img.attr('src');
                if (!originalSrc || originalSrc.startsWith('http') || img.parent().is('picture')) {
                    return;
                }

                const webpSrc = originalSrc.replace(/\.(jpe?g|png)$/i, '.webp');
                const webpPath = path.resolve(path.dirname(file), webpSrc);
                
                imagePromises.push(fileExists(webpPath).then(exists => {
                    if (exists) {
                        const picture = $('<picture></picture>');
                        const source = $('<source>').attr({
                            srcset: webpSrc,
                            type: 'image/webp'
                        });
                        img.wrap(picture);
                        picture.append(source).append(img);
                    }
                }));
            });

            await Promise.all(imagePromises);

            const minifiedHtml = await minify($.html(), {
                collapseWhitespace: true,
                removeComments: true,
                removeRedundantAttributes: true,
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                useShortDoctype: true,
            });
            await fs.writeFile(file, minifiedHtml, 'utf8');
            console.log(`  Processed: ${file}`);

        } catch (err) {
            console.error(`  Error processing HTML file ${file}:`, err.message);
        }
    }
}

// --- Main Execution ---

async function main() {
    console.log('🚀 Starting optimization pipeline...');
    
    const imageminTools = await loadImagemin();
    
    await minifyJs();
    await minifyCss();
    await optimizeImages(imageminTools);
    await processHtml();

    console.log('\n✅ Optimization complete!');
}

main().catch(err => {
    console.error('An unhandled error occurred during optimization:', err);
    process.exit(1);
});