const { JSDOM } = require('jsdom');
const { MongoClient } = require('mongodb');
const keywordExtractor = require('keyword-extractor');
const Bull = require('bull');
const Redis = require('ioredis');


// Redis and MongoDB connection details
const REDIS_URL = 'redis://127.0.0.1:6379';
const MONGO_URI = 'mongodb+srv://arkadeep:ZbIDql0NPpSbDpF1@sdd.pojzlat.mongodb.net/';
const MONGO_DB_NAME = 'dravel';

// Set up Redis for URL tracking
const redisClient = new Redis(REDIS_URL);

// Set up Redis queues for different priorities
const highPriorityQueue = new Bull('high-priority-queue', REDIS_URL);
const lowPriorityQueue = new Bull('low-priority-queue', REDIS_URL);

// MongoDB client
const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

async function connectMongoDB() {
    try {
        await client.connect();
        console.log("Connected to MongoDB");
        return client.db(MONGO_DB_NAME);
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err);
        process.exit(1);
    }
}

// Throttling settings
const MAX_CONCURRENT_REQUESTS = 5;
const REQUEST_DELAY = 1000; // Delay in milliseconds

let activeRequests = 0;
let domainQueue = new Set(); // To track domains for prioritization
let domainRequestQueue = new Map(); // To track requests for each domain

// Throttle requests to avoid crashing the site
function throttleRequests(fn) {
    return async function (...args) {
        while (activeRequests >= MAX_CONCURRENT_REQUESTS) {
            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
        }
        activeRequests++;
        try {
            await fn(...args);
        } catch (err) {
            console.error(`Error while processing request: ${err.message}`);
        } finally {
            activeRequests--;
        }
    };
}

// Process high and low priority queues
function processQueue(queue) {
    queue.process(async (job) => {
        const { baseURL, currentURL } = job.data;
        const db = await connectMongoDB();
        try {
            await crawlPage(baseURL, currentURL, db);
        } catch (err) {
            console.error(`Failed to process job for URL ${currentURL}: ${err.message}`);
        }
    });
}

processQueue(highPriorityQueue);
processQueue(lowPriorityQueue);

// Add URLs to the appropriate queue based on priority
async function addUrlToQueue(url, priority = 'low') {
    const normalizedUrl = normalizeURL(url);
    if (!normalizedUrl) return;

    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    // Check if the URL has already been crawled or is currently being processed
    const isProcessed = await redisClient.sismember('crawled_urls', normalizedUrl);
    if (isProcessed) {
        console.log(`Skipping already processed URL: ${normalizedUrl}`);
        return;
    }

    // Mark URL as processed
    await redisClient.sadd('crawled_urls', normalizedUrl);

    // Track domain requests
    if (!domainRequestQueue.has(domain)) {
        domainRequestQueue.set(domain, []);
    }
    domainRequestQueue.get(domain).push(url);

    // Prioritize domains not yet fully crawled
    if (!domainQueue.has(domain)) {
        domainQueue.add(domain);
    }

    const queueToUse = (priority === 'high') ? highPriorityQueue : lowPriorityQueue;
    await queueToUse.add({ baseURL: url, currentURL: url });
    console.log(`Added ${url} to ${priority} priority queue`);
}

const crawlPage = throttleRequests(async (baseURL, currentURL, db) => {
    try {
        // Normalize the current URL
        const normalizedCurrentURL = normalizeURL(currentURL);
        if (!normalizedCurrentURL) {
            console.log(`Invalid URL: ${currentURL}`);
            return; // Skip processing for invalid URLs
        }

        // Fetch the page
        const resp = await fetch(normalizedCurrentURL);

        if (resp.status > 399) {
            console.log(`Error fetching page: ${resp.statusText}`);
            return;
        }

        const contentType = resp.headers.get("content-type");
        if (!contentType || !contentType.includes('text/html')) {
            console.log("Non-HTML content type");
            return;
        }

        const htmlBody = await resp.text();
        const nextUrls = await getURLsfromHTML(htmlBody, baseURL);

        // Extract and save keywords and metadata
        const siteType = await extractAndSaveData(htmlBody, normalizedCurrentURL, db);

        // Process URLs from other domains before revisiting the same domain
        const domain = new URL(normalizedCurrentURL).hostname;
        domainQueue.delete(domain);

        // Add the next URLs to the queue with priority based on site type
        const nextPriority = determineRecrawlPriority(siteType);
        for (const nextUrl of nextUrls) {
            const normalizedNextUrl = normalizeURL(nextUrl);
            if (normalizedNextUrl) {
                await addUrlToQueue(normalizedNextUrl, nextPriority);
            } else {
                console.log(`Skipping invalid next URL: ${nextUrl}`);
            }
        }

        // Process URLs from the current domain if available
        if (domainRequestQueue.has(domain)) {
            const domainUrls = domainRequestQueue.get(domain);
            domainRequestQueue.delete(domain); // Clear the queue for this domain
            for (const url of domainUrls) {
                const normalizedDomainUrl = normalizeURL(url);
                if (normalizedDomainUrl) {
                    await addUrlToQueue(normalizedDomainUrl, nextPriority);
                } else {
                    console.log(`Skipping invalid domain URL: ${url}`);
                }
            }
        }
    } catch (err) {
        console.log(`Error processing URL ${currentURL}: ${err.message}`);
    }
});

// Extract data, classify website type, and save to MongoDB
async function extractAndSaveData(htmlBody, url, db) {
    const dom = new JSDOM(htmlBody);
    const document = dom.window.document;

    // Extract text content excluding <script> and <style> tags
    const textContent = [...document.body.querySelectorAll('*')]
        .filter(element => element.tagName !== 'SCRIPT' && element.tagName !== 'STYLE')
        .map(element => element.textContent)
        .join(' ');

    const paragraphs = Array.from(document.querySelectorAll('p'))
        .map(p => p.textContent.trim())
        .filter(text => text.length > 0);

    const joinedPara = [...paragraphs].join(' ');

    const keywords = keywordExtractor.extract(textContent, {
        language: "english",
        remove_digits: true,
        return_changed_case: true,
        remove_duplicates: true,
    });

    // Extract meta description and title
    const description = document.querySelector("meta[name='description']")?.getAttribute("content") || joinedPara;
    const title = document.querySelector("title")?.textContent || "";

    // Determine site type based on extracted keywords or metadata
    const siteType = classifyWebsiteType(keywords, description);

    const collection = db.collection('keywords');
    try {
        await collection.insertOne({
            url,
            title,
            description,
            keywords,
            siteType,
        });
        console.log(`Data saved for ${url}`);
    } catch (err) {
        console.error(`Failed to insert data for ${url}:`, err);
    }

    return siteType;
}

// Function to classify website type
function classifyWebsiteType(keywords, metaDescription) {
    const newsKeywords = ["news", "breaking", "update"];
    const blogKeywords = ["blog", "post", "comment"];
    const ecommerceKeywords = ["buy", "shop", "price"];

    // Simple classification logic
    if (keywords.some(keyword => newsKeywords.includes(keyword))) {
        return "news";
    } else if (keywords.some(keyword => blogKeywords.includes(keyword))) {
        return "blog";
    } else if (keywords.some(keyword => ecommerceKeywords.includes(keyword))) {
        return "ecommerce";
    } else {
        return "other";
    }
}

// Determine recrawl priority based on website type
function determineRecrawlPriority(siteType) {
    switch (siteType) {
        case 'news':
            return 'high'; // Frequently updated
        case 'blog':
        case 'ecommerce':
            return 'low'; // Less frequently updated
        default:
            return 'low'; // Default to low
    }
}

// Extract URLs from HTML with filtering and handle relative links
async function getURLsfromHTML(htmlBody, baseURL) {
    const urls = [];
    const dom = new JSDOM(htmlBody);
    const linkElements = dom.window.document.querySelectorAll('a');

    // Define keywords to filter out unwanted links
    const filterKeywords = ["privacy", "terms", "conditions", "payment", "donate", "cookie", "subscription"];

    for (const linkElement of linkElements) {
        let href = linkElement.getAttribute('href');

        // Ignore links that are neither relative nor absolute
        if (!href || (!href.startsWith('/') && !href.startsWith('http'))) {
            console.log(`Ignored non-relative or non-absolute link: ${href}`);
            continue;
        }

        // Convert relative URLs to absolute URLs
        try {
            href = new URL(href, baseURL).href;
        } catch (err) {
            console.error(`Failed to convert relative URL to absolute: ${err.message}`);
            continue;
        }

        const isFiltered = filterKeywords.some(keyword => href.includes(keyword));
        if (!isFiltered && !href.includes('#')) {
            urls.push(href);
        } else {
            console.log(`Filtered out unwanted link: ${href}`);
        }
    }

    return urls;
}

// Normalize URLs to avoid duplicate processing
function normalizeURL(url) {
    try {
        const normalizedUrl = new URL(url);
        normalizedUrl.hash = ''; // Remove fragment
        normalizedUrl.search = ''; // Remove query parameters
        return normalizedUrl.href;
    } catch (err) {
        console.log(`Invalid URL format: ${url}`);
        return null;
    }
}

module.exports = {
    addUrlToQueue
}
