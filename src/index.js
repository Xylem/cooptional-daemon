'use strict';

if (!process.env.YT_API_KEY) {
    throw new Error('YouTube API key missing!');
}

if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET || !process.env.REDDIT_REFRESH_TOKEN) {
    throw new Error('Reddit credentials missing!');
}

const _ = require('lodash');
const co = require('co');
const request = require('co-request');
const cf = require('co-functional');
const Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs'));
const path = require('path');
const url = require('url');
const exec = require('child_process').exec;
const gd = require('node-gd');
const ytdl = Promise.promisifyAll(require('ytdl-core'));
const printf = require('printf');
const lowdb = require('lowdb');
const db = lowdb('./db/db.json');
const snoowrap = require('snoowrap');
const reddit = new snoowrap({
    userAgent: 'cooptional-daemon v1.0.0',
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    refreshToken: process.env.REDDIT_REFRESH_TOKEN
});

const TEMP_DIR = './tmp';
const FRAME_FILENAME = 'frames.txt';
const CLIP_WIDTH = 1280;
const CLIP_HEIGHT = 30;
const MINIMAL_HEIGHT = 14; // minimal height of frame after cropping white borders
const MAXIMAL_OFF_CENTER_FACTOR = 10; // how much off-center a caption can be
const EMPTY_BAND_HEIGHT = 2; // height of bands on top and at the bottom of the clipped frame that should be relatively empty in captions
const WHITE_THRESHOLD = 250; // value 0-255 - lowest bound for color to be still considered white - 255 = pure white
const BLACK_THRESHOLD = 5; // value 0-255 - highest bound for color to be still considered blac - 0 = pure black
const CAPTION_NON_WHITE_THRESHOLD = 20; // how many non-white pixels can be found in the empty bands for the image to be considered caption
const CAPTION_BLACK_THRESHOLD = 1000; // how many black pixels must there be between empty bands for image to be considered caption
const DIFFERENCE_THRESHOLD = 300; // how many pixels must image differ from previous to be considered a new caption

const OFFSET = 60; // timestamps will be offset back by this many seconds to account for delay in changing captions
const PLAYLIST_ID = 'UUy1Ms_5qBTawC-k7PVjHXKQ';
const SUBREDDITS = [ 'cynicalbrit', 'cynicalbritofficial' ];

const r = color => color & 0xff0000 >> 16;
const g = color => color & 0x00ff00 >> 8;
const b = color => color & 0x0000ff;

function calculateImageDifference (imageA, imageB) {
    let imageDifference = 0;
    let x;
    let y;
    let imageAPixelColor;
    let imageBPixelColor;

    let isABlack;
    let isBBlack;

    for (y = 0; y < CLIP_HEIGHT; ++y) {
        for (x = 0; x < CLIP_WIDTH; ++x) {
            imageAPixelColor = imageA.getTrueColorPixel(x, y);
            imageBPixelColor = imageB.getTrueColorPixel(x, y);

            isBBlack = r(imageAPixelColor) < 200 && g(imageAPixelColor) < 200 && b(imageAPixelColor) < 200;
            isABlack = r(imageBPixelColor) < 200 && g(imageBPixelColor) < 200 && b(imageBPixelColor) < 200;

            if (isBBlack != isABlack) {
                ++imageDifference;
            }
        }
    }

    return imageDifference;
}

function removeImageFile(file) {
    file.image.destroy();
    fs.unlinkSync(file.path);
    delete file.image;
}

function execAsync(command, options) {
    return new Promise((resolve, reject) => exec(command, options, (err, stdout, stderr) => {
        err ? reject({
            error: err,
            stdout: stdout,
            stderr: stderr
        }) : resolve({
            stdout: stdout,
            stderr: stderr
        })
    }))
}

function checkVideoAlreadyPosted(videoID) {
    return SUBREDDITS.every(subreddit => db.get(`videos.${videoID}.subreddits.${subreddit}.post`).value());
}

function * getVideoData() {
    const response = yield request({
        url: `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${PLAYLIST_ID}&key=${process.env.YT_API_KEY}`,
        json: true
    });

    if (response.statusCode !== 200) {
        throw new Error(`Unexpected status code ${response.statusCode}`);
    }

    const videoData = response.body && response.body.items && _.find(response.body.items, item =>
        item.snippet && item.snippet.title.startsWith('The Co-Optional Podcast Ep.'));

    return {
        videoTitle: videoData && videoData.snippet.title,
        videoID: videoData && videoData.snippet.resourceId.videoId
    };
}

function * getVideoFileURL(youtubeURL) {
    const videoData = yield ytdl.getInfoAsync(youtubeURL);
    const videoFileData = _.find(videoData.formats, {
        itag: '136'
    });

    return videoFileData && videoFileData.url;
}

function * generateCaptionImages (videoFileURL) {
    yield execAsync(`ffmpeg -i '${videoFileURL}' -vf "fps=1[skipped];
        [skipped]crop=in_w:${CLIP_HEIGHT}:0:in_h-${CLIP_HEIGHT}[cropped];
        [cropped]mpdecimate=lo=64*10:hi=64*20,showinfo[decimated];
        [decimated]hue=s=0[bw];
        [bw]curves=m='0/1 .3/1 .31/0 1/0'" -vsync 0 %5d.png 2>&1 >/dev/null |
        grep -E -o 'pts:[[:space:]]+[[:digit:]]+' |
        awk '{print $2}' > ${FRAME_FILENAME}`, {
        cwd: path.resolve(TEMP_DIR)
    });
}

function getPixelAt(image, x, y) {
    return image.getBoundsSafe(x, y) ? image.getTrueColorPixel(x, y) : 0xffffff;
}

function isPixelBlack(color) {
    return r(color) < BLACK_THRESHOLD || g(color) < BLACK_THRESHOLD || b(color) < BLACK_THRESHOLD;
}

function isPixelNotWhite(color) {
    return r(color) < WHITE_THRESHOLD || g(color) < WHITE_THRESHOLD || b(color) < WHITE_THRESHOLD;
}

function despeckle(file) {
    let x, y, dx, dy, blackCount;

    for (y = 0; y < CLIP_HEIGHT; ++y) {
        for (x = 0; x < CLIP_WIDTH; ++x) {
            const pixelColor = file.image.getTrueColorPixel(x, y);

            if (isPixelBlack(pixelColor)) {
                blackCount = 0;

                for (dy = y - 1; dy <= y + 1; ++dy) {
                    for (dx = x - 1; dx <= x + 1; ++dx) {
                        if (isPixelBlack(getPixelAt(file.image, dx, dy))) {
                            ++blackCount;
                        }
                    }
                }

                if (blackCount <= 1) {
                    file.image.setPixel(x, y, 0xffffff);
                }
            }
        }
    }
}

function detectSideBorders(file) {
    let x, y;

    for (x = 0; x < CLIP_WIDTH; ++x) {
        for (y = 0; y < CLIP_HEIGHT; ++y) {
            const pixelColor = file.image.getTrueColorPixel(x, y);

            if (isPixelBlack(pixelColor)) {
                file.leftmostBlackX = x;
                break;
            }
        }
    }

    for (x = CLIP_WIDTH - 1; x >= 0; --x) {
        for (y = 0; y < CLIP_HEIGHT; ++y) {
            const pixelColor = file.image.getTrueColorPixel(x, y);

            if (isPixelBlack(pixelColor)) {
                file.rightmostBlackX = x;
                break;
            }
        }
    }
}

function * filterUniqueCaptionImages () {
    return (yield fs.readdirAsync(TEMP_DIR))
        .filter(filename => filename.endsWith('.png'))
        .map(filename => {
            const filePath = path.join(TEMP_DIR, filename);
            return {
                path: filePath,
                name: filename,
                basename: path.basename(filename, '.png'),
                image: gd.createFromPng(filePath)
            };
        })
        .filter(file => {
            const img = file.image;
            let nonWhitePixelCount = 0;
            let blackPixelCount = 0;
            let x;
            let y;
            let pixelColor;

            for (y = 0; y < EMPTY_BAND_HEIGHT; ++y) {
                for (x = 0; x < CLIP_WIDTH; ++x) {
                    pixelColor = img.getTrueColorPixel(x, y);

                    if (isPixelNotWhite(pixelColor)) {
                        ++nonWhitePixelCount;
                    }
                }
            }

            for (y = EMPTY_BAND_HEIGHT; y < CLIP_HEIGHT - EMPTY_BAND_HEIGHT; ++y) {
                for (x = 0; x < CLIP_WIDTH; ++x) {
                    pixelColor = img.getTrueColorPixel(x, y);

                    if (isPixelBlack(pixelColor)) {
                        ++blackPixelCount;
                    }
                }
            }

            for (y = CLIP_HEIGHT - EMPTY_BAND_HEIGHT; y < CLIP_HEIGHT; ++y) {
                for (x = 0; x < CLIP_WIDTH; ++x) {
                    pixelColor = img.getTrueColorPixel(x, y);

                    if (isPixelNotWhite(pixelColor)) {
                        ++nonWhitePixelCount;
                    }
                }
            }

            const kept = nonWhitePixelCount <= CAPTION_NON_WHITE_THRESHOLD && blackPixelCount >= CAPTION_BLACK_THRESHOLD;

            if (!kept) {
                removeImageFile(file);
            }

            return kept;
        })
        .filter(file => {
            despeckle(file);
            detectSideBorders(file);

            const offCenterFactor = Math.abs(CLIP_WIDTH - file.leftmostBlackX - file.rightmostBlackX);

            const kept = offCenterFactor <= MAXIMAL_OFF_CENTER_FACTOR;

            if (!kept) {
                removeImageFile(file);
            }

            return kept;
        })
        .filter(file => {
            const croppedToText = file.image.cropAuto(4);

            const kept = croppedToText.height >= MINIMAL_HEIGHT;

            croppedToText.destroy();

            if (!kept) {
                removeImageFile(file);
            }

            return kept;
        })
        .filter((file, index, array) => {
            if (index === 0) {
                file.kept = true;
                return true;
            }
            const previous = array[index - 1];
            const kept = calculateImageDifference(file.image, previous.image) >= DIFFERENCE_THRESHOLD;

            if (!previous.kept) {
                removeImageFile(previous);
            }

            if (index === array.length - 1 && !kept) {
                removeImageFile(file);
            }

            file.kept = kept;

            return kept;
        });
}

function * matchTimecodes (captions, offset) {
    const frameTimecodes = (yield fs.readFileAsync(path.join(TEMP_DIR, FRAME_FILENAME), 'utf8')).split('\n');

    captions.forEach(caption => {
        caption.time = Math.max(0, parseInt(frameTimecodes[parseInt(caption.basename, 10) - 1], 10) - offset);
    })
}

function * matchText (file) {
    const croppedToText = file.image.cropAuto(4);
    const scaled = gd.createTrueColorSync(croppedToText.width * 4, croppedToText.height * 4);

    croppedToText.copyResized(scaled, 0, 0, 0, 0, scaled.width, scaled.height, croppedToText.width, croppedToText.height);
    croppedToText.destroy();

    yield new Promise((resolve, reject) => scaled.savePng(file.path, -1, err => {
        scaled.destroy();
        err ? reject(err) : resolve();
    }));

    yield execAsync(`ocropus-rpred -m ./src/font/xolonium-00019000.pyrnn.gz ${file.path}`);

    removeImageFile(file);

    try {
        file.caption = (yield fs.readFileAsync(path.join(TEMP_DIR, file.basename + '.txt'), 'utf8')).trim();
    } catch (e) {
        console.error(`File ${file.basename}.txt is not readable`);
        file.unreadable = true;
    }
}

function formatAsTime(timestamp) {
    const second = timestamp % 60;
    const minute = ((timestamp - second) % 3600) / 60;
    const hour = (timestamp - second - 60 * minute) / 3600;

    return printf('%02d:%02d:%02d', hour, minute, second);
}

function buildCaptions(captions, videoURL) {
    const listHeader = 'Approximate timestamps to specific topics\n\n&nbsp;\n\nTopic|Timestamp\n-|-\n';
    const listFooter = '\n\n&nbsp;\n\n^^Generated ^^automatically ^^by ^^https://github.com/Xylem/cooptional-daemon';

    const rawVideoUrl = url.parse(videoURL, true);

    const list = captions.filter(caption => {
        return !caption.unreadable;
    }).map(caption => {
        const timestampURL = _.cloneDeep(rawVideoUrl);
        timestampURL.query.t = caption.time;
        delete timestampURL.search;

        return printf('%s|[%s](%s)', caption.caption, formatAsTime(caption.time), url.format(timestampURL));
    }).join('\n');

    return listHeader + list + listFooter;
}

function * generateCaptions (videoURL, videoID) {
    if (db.has(`videos.${videoID}.captionsText`).value()) {
        console.log(`Captions for video ${videoID} already exist`);

        return db.get(`videos.${videoID}.captionsText`).value();
    }

    console.log(`Captions for video ${videoID} missing - trying to generate`);

    const videoFileURL = yield getVideoFileURL(videoURL);

    if (!videoFileURL) {
        throw new Error(`720p video URL for video ${videoID} missing!`);
    }

    console.log(`Processing video ${videoID} from URL ${videoFileURL}`);

    yield generateCaptionImages(videoFileURL);

    console.log(`Generated caption images for ${videoID}`);

    const captions = yield filterUniqueCaptionImages();

    console.log(`Filtered caption images for ${videoID}`);

    yield matchTimecodes(captions, OFFSET);

    yield cf.mapSerial(matchText, captions);
    const captionsText = buildCaptions(captions, videoURL);

    console.log(`Built captions for ${videoID}`);

    db.set(`videos.${videoID}.captionsText`, captionsText).value();

    return captionsText;
}

function postToSubreddit(videoTitle, videoURL, videoID, captionsText) {
    return function * (subreddit) {
        console.log(`Searching for Reddit thread on /r/${subreddit} for video ${videoID}`);
        let post = yield reddit.search({
            query: `url:${videoID}`,
            subreddit: subreddit,
            syntax: 'lucene'
        })[0];

        if (!post) {
            console.log(`Reddit thread on /r/${subreddit} for video ${videoID} not found - creating`);

            post = yield r.getSubreddit(subreddit).submitLink({
                title: videoTitle,
                url: videoURL
            });
        }

        console.log(`Reddit thread on /r/${subreddit} for video ${videoID} found - posting captions`);

        const reply = yield post.reply(captionsText);

        console.log(`Posted captions on /r/${subreddit} for video ${videoID}`);

        db.set(`videos.${videoID}.subreddits.${subreddit}.post`, {
            created: reply.created_utc,
            id: reply.id
        }).value();
    }
}

function * postCaptionsToReddit(videoTitle, videoURL, videoID, captionsText) {
     yield cf.forEach(postToSubreddit(videoTitle, videoURL, videoID, captionsText), SUBREDDITS);
}

function wait(n) {
    return new Promise(resolve => setTimeout(resolve, n));
}

function * runProcessing () {
    while (true) {
        try {
            const {videoID, videoTitle} = yield getVideoData();
            if (!videoID) {
                continue;
            }

            if (checkVideoAlreadyPosted(videoID)) {
                continue;
            }

            console.log(`Found video without captions posted: ID ${videoID}`);
            const videoURL = `https://www.youtube.com/watch?v=${videoID}`;

            const captionsText = yield generateCaptions(videoURL, videoID);

            yield postCaptionsToReddit(videoTitle, videoURL, videoID, captionsText);
        } catch (e) {
            console.error(e);
        }

        yield wait(60000);
    }
}

co(runProcessing);
