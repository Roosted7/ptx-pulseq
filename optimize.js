// optimize.js
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');
const os = require('os');
const crypto = require('crypto');
const CACHE_DIR = path.resolve(__dirname, '.cache', 'images');

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
    const imageminPngquant = (await import('imagemin-pngquant')).default;
    const imageminOptipng = (await import('imagemin-optipng')).default;
    const imageminZopfli = (await import('imagemin-zopfli')).default;
    const imageminSvgo = (await import('imagemin-svgo')).default;
    const imageminWebp = (await import('imagemin-webp')).default;
    return { imagemin, imageminGifsicle, imageminJpegtran, imageminPngquant, imageminOptipng, imageminZopfli, imageminSvgo, imageminWebp };
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

// --- Utility Functions ---
function fmtSize(n) {
    return n > 2048 ? `${(n/1024).toFixed(1)}kb` : `${n}b`;
}

function logSavings(label, file, original, result, saved) {
    const percent = ((saved / original) * 100).toFixed(1);
    if (saved > 0) {
        console.log(`  ${label}: ${file} (Original: ${fmtSize(original)}, New: ${fmtSize(result)}, Saved: ${fmtSize(saved)} [${percent}%])`);
    } else {
        console.log(`  Skipping: ${file} (Original: ${fmtSize(original)}, New: ${fmtSize(result)}, No savings)`);
    }
}

function computeSavings(original, result) {
    return original - result;
}

// --- Generic file processing with stats ---
async function runWithStats(pattern, title, processFn, writeOpts = 'utf8') {
    if (!pLimit) pLimit = (await import('p-limit')).default;
    console.log(title);
    const files = await glob(pattern);
    let totalOriginal = 0, totalSaved = 0;
    const limit = pLimit(os.cpus().length);
    await Promise.all(files.map(file => limit(async () => {
        try {
            const { originalSize, newSize, output, writePath, label } = await processFn(file);
            totalOriginal += originalSize;
            const saved = computeSavings(originalSize, newSize);
            if (newSize < originalSize) {
                totalSaved += saved;
                logSavings(label, writePath, originalSize, newSize, saved);
                await fs.writeFile(writePath, output, writeOpts);
            } else {
                logSavings('Skipping', writePath, originalSize, newSize, 0);
            }
        } catch (err) {
            console.error(`  Error processing file ${file}:`, err.message);
        }
    })));
    if (totalSaved > 0) {
        const percent = ((totalSaved / totalOriginal) * 100).toFixed(1);
        console.log(`  Total ${title.replace(/--- /g, '')} savings: ${fmtSize(totalSaved)} / ${fmtSize(totalOriginal)} [${percent}%]`);
    }
    return { original: totalOriginal, saved: totalSaved };
}

// --- Optimization Functions ---

async function minifyJs() {
    return runWithStats(
        `${SITE_DIR}/**/*.js`,
        '--- Minifying JavaScript files ---',
        async file => {
            const originalContent = await fs.readFile(file, 'utf8');
            const result = await terser.minify(originalContent);
            if (result.error) throw result.error;
            const originalSize = Buffer.byteLength(originalContent, 'utf8');
            const newSize = Buffer.byteLength(result.code, 'utf8');
            return { originalSize, newSize, output: result.code, writePath: file, label: 'Minifying' };
        }
    );
}

async function minifyCss() {
    const processor = postcss([cssnano]);
    return runWithStats(
        `${SITE_DIR}/**/*.css`,
        '\n--- Minifying CSS files ---',
        async file => {
            const originalContent = await fs.readFile(file, 'utf8');
            const cleanContent = originalContent.replace(/\/\*# sourceMappingURL=.*\*\//g, '');
            const result = await processor.process(cleanContent, { from: undefined });
            const originalSize = Buffer.byteLength(originalContent, 'utf8');
            const newSize = Buffer.byteLength(result.css, 'utf8');
            return { originalSize, newSize, output: result.css, writePath: file, label: 'Minifying' };
        }
    );
}

async function optimizeImages(imageminTools) {
    // --- Lossless & cached optimization for images ---
    const { imagemin, imageminGifsicle, imageminJpegtran, imageminPngquant, imageminOptipng, imageminZopfli, imageminSvgo, imageminWebp } = imageminTools;
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const optimizeFn = async file => {
        const originalBuffer = await fs.readFile(file);
        const hash = crypto.createHash('md5').update(originalBuffer).digest('hex');
        const ext = path.extname(file);
        const cacheImgPath = path.join(CACHE_DIR, `${hash}${ext}`);
        let optimizedBuffer;
        if (await fileExists(cacheImgPath)) {
            optimizedBuffer = await fs.readFile(cacheImgPath);
            console.log(`  Cache hit: ${file}`);
        } else {
            let temp = originalBuffer;
            if (/\.png$/i.test(file)) {
                let buf = await imagemin.buffer(originalBuffer, { plugins: [imageminPngquant({ quality: [0.7,0.95], speed:2 })] });
                if (!(buf instanceof Buffer)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
                temp = await imagemin.buffer(buf, { plugins: [imageminOptipng({ optimizationLevel:7 }), imageminZopfli({ more:true })] });
            } else {
                temp = await imagemin.buffer(originalBuffer, { plugins: [imageminGifsicle({ interlaced:true }), imageminJpegtran({ progressive:true }), imageminSvgo()] });
            }
            optimizedBuffer = temp;
            await fs.writeFile(cacheImgPath, optimizedBuffer);
        }
        const originalSize = originalBuffer.length;
        const newSize = optimizedBuffer.length;
        return { originalSize, newSize, output: optimizedBuffer, writePath: file, label: 'Optimizing' };
    };
    // Run lossless optimization
    const stats = await runWithStats(
        `${SITE_DIR}/**/*.{jpg,jpeg,png,gif,svg}`,
        '\n--- Optimizing Images (Lossless) ---',
        optimizeFn,
        null
    );
    // WebP conversion
    let webpSaved = 0;
    const images = await glob(`${SITE_DIR}/**/*.{jpg,jpeg,png}`);
    const limit = pLimit(os.cpus().length);
    await Promise.all(images.map(file => limit(async () => {
        try {
            const buf = await fs.readFile(file);
            const preSize = buf.length;
            const webpBuf = await imagemin.buffer(buf, { plugins: [imageminWebp({ quality:85 })] });
            const webpPath = file.replace(/\.(jpe?g|png)$/i,'.webp');
            const saved = preSize - webpBuf.length;
            if (saved > MIN_SAVINGS_BYTES) {
                await fs.writeFile(webpPath, webpBuf);
                webpSaved += saved;
                const pct = ((saved/preSize)*100).toFixed(1);
                console.log(`  WebP:    ${webpPath} (Saved: ${fmtSize(saved)} [${pct}%])`);
            } else {
                try { await fs.unlink(webpPath); } catch {}
                console.log(`  WebP:    ${webpPath} (Not kept, savings ${fmtSize(saved)} < ${MIN_SAVINGS_BYTES}b)`);
            }
        } catch (err) {
            console.error(`  Error generating WebP for ${file}:`, err.message);
        }
    })));
    if (webpSaved > 0) console.log(`  Total WebP savings: ${fmtSize(webpSaved)}`);
    return { original: stats.original, saved: stats.saved + webpSaved };
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