// optimize.js
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');
const os = require('os');
let pLimit;
const terser = require('terser');
const postcss = require('postcss');
const cssnano = require('cssnano');
const cheerio = require('cheerio');
const { minify } = require('html-minifier-terser');

// --- Configuration ---
// The minimum number of bytes an optimization must save to be applied.
// This helps prevent tiny optimizations that are outweighed by HTML overhead.
const MIN_SAVINGS_BYTES = 150;

// --- Helper to dynamically import ESM-only imagemin packages ---
async function loadImagemin() {
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
    if (!pLimit) pLimit = (await import('p-limit')).default;
    console.log('--- Minifying JavaScript files ---');
    const jsFiles = await glob(`${SITE_DIR}/**/*.js`);
    const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(jsFiles.map(file => limit(async () => {
        try {
            const originalContent = await fs.readFile(file, 'utf8');
            const result = await terser.minify(originalContent);
            if (result.error) {
                console.error(`  Terser error in ${file}:`, result.error);
                return;
            }
            const originalSize = Buffer.byteLength(originalContent, 'utf8');
            const newSize = Buffer.byteLength(result.code, 'utf8');
            const saved = originalSize - newSize;
            const percent = ((saved / originalSize) * 100).toFixed(1);
            totalOriginal += originalSize;
            if (newSize < originalSize) {
                totalSaved += saved;
                console.log(`  Minifying: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Saved: ${fmt(saved)} [${percent}%])`);
                await fs.writeFile(file, result.code, 'utf8');
            } else {
                console.log(`  Skipping: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, No savings)`);
            }
        } catch (err) {
            console.error(`  Error processing JS file ${file}:`, err.message);
        }
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total JS savings: ${fmt(totalSaved)} / ${fmt(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
}

async function minifyCss() {
    if (!pLimit) pLimit = (await import('p-limit')).default;
    console.log('\n--- Minifying CSS files ---');
    const cssFiles = await glob(`${SITE_DIR}/**/*.css`);
    const processor = postcss([cssnano]);
    const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(cssFiles.map(file => limit(async () => {
        try {
            const originalContent = await fs.readFile(file, 'utf8');
            const cleanContent = originalContent.replace(/\/\*# sourceMappingURL=.*\*\//g, '');
            const result = await processor.process(cleanContent, { from: undefined });
            const originalSize = Buffer.byteLength(originalContent, 'utf8');
            const newSize = Buffer.byteLength(result.css, 'utf8');
            const saved = originalSize - newSize;
            const percent = ((saved / originalSize) * 100).toFixed(1);
            totalOriginal += originalSize;
            if (newSize < originalSize) {
                totalSaved += saved;
                console.log(`  Minifying: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Saved: ${fmt(saved)} [${percent}%])`);
                await fs.writeFile(file, result.css, 'utf8');
            } else {
                console.log(`  Skipping: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, No savings)`);
            }
        } catch (err) {
            console.error(`  Error processing CSS file ${file}: ${err.message}`);
        }
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total CSS savings: ${fmt(totalSaved)} / ${fmt(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
}

async function optimizeImages(imageminTools) {
    if (!pLimit) pLimit = (await import('p-limit')).default;
    const { imagemin, imageminGifsicle, imageminJpegtran, imageminOptipng, imageminSvgo, imageminWebp } = imageminTools;
    const imageFiles = await glob(`${SITE_DIR}/**/*.{jpg,jpeg,png,gif,svg}`);

    console.log('\n--- Optimizing Images (Lossless) & Generating WebP ---');

    const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(imageFiles.map(file => limit(async () => {
        try {
            const originalBuffer = await fs.readFile(file);
            const originalSize = originalBuffer.length;
            // 1. Perform lossless optimization
            const optimizedBuffer = await imagemin.buffer(originalBuffer, {
                plugins: [
                    imageminGifsicle({ interlaced: true }),
                    imageminJpegtran({ progressive: true }),
                    imageminOptipng({ optimizationLevel: 7 }),
                    imageminSvgo()
                ]
            });
            const newSize = optimizedBuffer.length;
            const savings = originalSize - newSize;
            const percent = ((savings / originalSize) * 100).toFixed(1);
            totalOriginal += originalSize;
            if (savings > MIN_SAVINGS_BYTES) {
                totalSaved += savings;
                console.log(`  Optimizing: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Saved: ${fmt(savings)} [${percent}%])`);
                await fs.writeFile(file, optimizedBuffer);
            } else {
                console.log(`  Skipping: ${file} (Original: ${fmt(originalSize)}, New: ${fmt(newSize)}, Savings of ${fmt(savings)} [${percent}%] is below threshold of ${MIN_SAVINGS_BYTES}b)`);
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
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total image savings: ${fmt(totalSaved)} / ${fmt(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
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
    
    const jsStats = await minifyJs();
    const cssStats = await minifyCss();
    const imgStats = await optimizeImages(imageminTools);
    await processHtml();

    const overallOriginal = jsStats.original + cssStats.original + imgStats.original;
    const overallSaved = jsStats.saved + cssStats.saved + imgStats.saved;
    if (overallSaved > 0) {
        const fmt = (n) => n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
        const percent = ((overallSaved / overallOriginal) * 100).toFixed(1);
        console.log(`\n💡 Overall total savings: ${fmt(overallSaved)} / ${fmt(overallOriginal)} [${percent}%]`);
    }

    console.log('\n✅ Optimization complete!');
}

main().catch(err => {
    console.error('An unhandled error occurred during optimization:', err);
    process.exit(1);
});