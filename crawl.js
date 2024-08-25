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
        console.log(normalizedCurrentURL)
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
        const dom = new JSDOM(htmlBody);
        const document = dom.window.document;

        if (!document) {
            console.log(`Failed to parse HTML for URL: ${normalizedCurrentURL}`);
            return;
        }

        // Extract URLs and metadata
        const nextUrls = await getURLsfromHTML(htmlBody, baseURL);
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
        console.error(`Error processing URL ${currentURL}: ${err.message}`);
    }
});
// Extract data, classify website type, and save to MongoDB
async function extractAndSaveData(htmlBody, url, db) {
    const dom = new JSDOM(htmlBody);
    const document = dom.window.document;

    // Extract and save text content
    const textContent = extractTextContent(document);
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

    const description = document.querySelector("meta[name='description']")?.getAttribute("content") || joinedPara;
    const title = document.querySelector("title")?.textContent || "";

    const siteType = classifyWebsiteType(keywords, description);

    // Extract images with their alt text
    const images = [...document.querySelectorAll('img')].map(img => ({
        src: img.src,
        alt: img.alt || '' // Provide a default empty string if alt is not available
    }));

    // Extract videos
    const videos = [...document.querySelectorAll('video')].map(video => video.src);

    // Extract products from e-commerce pages
    const products = extractEcommerceData(document, new URL(url).hostname);

    // Save data to MongoDB
    const collection = db.collection('keywords');

    try {
        await collection.updateOne(
            { url },
            {
                $set: {
                    title,
                    description,
                    keywords,
                    siteType,
                    content: textContent,
                    images, // Save image objects with src and alt
                    videos,
                    price: products
                }
            },
            { upsert: true } // Update if exists, insert if not
        );
        console.log(`Data saved for ${url}`);
    } catch (err) {
        console.error(`Failed to insert data for ${url}:`, err);
    }

    return siteType;
}


// Function to classify website type
function classifyWebsiteType(keywords, metaDescription) {
    const types = {
        'news': ['news', 'breaking', 'update'],
        'blog': ['blog', 'post', 'comment'],
        'ecommerce': ['buy', 'shop', 'price'],
        'socialmedia': ['social', 'tweet', 'facebook', 'instagram'],
    };

    const keywordMap = Object.keys(types).find(type => 
        keywords.some(keyword => types[type].includes(keyword))
    );

    if (keywordMap) return keywordMap;

    const descriptionKeywords = metaDescription.toLowerCase();
    if (descriptionKeywords.includes('news')) return 'news';
    if (descriptionKeywords.includes('blog')) return 'blog';
    if (descriptionKeywords.includes('buy') || descriptionKeywords.includes('shop')) return 'ecommerce';
    if (descriptionKeywords.includes('social')) return 'socialmedia';

    return 'other';
}

// Determine recrawl priority based on website type and other factors
function determineRecrawlPriority(siteType, updateFrequency = 'medium', importance = 'medium') {
    // Define priority levels for different site types
    const siteTypePriority = {
        news: 'high',        // News sites are frequently updated
        socialmedia: 'high', // Social media sites are frequently updated
        ecommerce: 'medium', // E-commerce sites are updated less frequently but still regularly
        blog: 'medium',      // Blogs are updated occasionally
        forum: 'medium',     // Forums may have occasional updates
        corporate: 'low',    // Corporate sites are updated infrequently
        educational: 'low',  // Educational sites may have occasional updates
        other: 'low'         // Other or uncategorized sites default to low
    };

    // Adjust priority based on additional factors
    const updateFrequencyAdjustment = {
        high: 1,
        medium: 0,
        low: -1
    };

    const importanceAdjustment = {
        high: 1,
        medium: 0,
        low: -1
    };

    // Calculate base priority
    let basePriority = siteTypePriority[siteType] || 'low'; // Default to 'low' if siteType not found

    // Adjust priority based on update frequency and importance
    let priorityAdjustment = updateFrequencyAdjustment[updateFrequency] + importanceAdjustment[importance];
    
    // Calculate final priority level
    switch (basePriority) {
        case 'high':
            return priorityAdjustment > 0 ? 'high' : 'medium';
        case 'medium':
            return priorityAdjustment > 0 ? 'high' : (priorityAdjustment < 0 ? 'low' : 'medium');
        case 'low':
        default:
            return priorityAdjustment < 0 ? 'low' : 'medium';
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
            continue;
        }

        // Check if the link contains any of the filter keywords
        if (filterKeywords.some(keyword => href.toLowerCase().includes(keyword))) {
            continue;
        }

        // Resolve relative URLs
        const url = new URL(href, baseURL).href;
        if (!urls.includes(url)) {
            urls.push(url);
        }
    }

    return urls;
}

// Extract text content from HTML and filter out styles/scripts
// Extract text content excluding <script> and <style> tags and remove inline styles
function extractTextContent(document) {
    if (!document) {
        throw new Error("Document is not initialized.");
    }

    // Remove <style> and <script> tags
    const elementsToRemove = document.querySelectorAll('style, script');
    elementsToRemove.forEach(element => {
        console.log(`Removing element: ${element.tagName}`);
        element.remove();
    });

    // Optionally remove other non-content elements
    const tagsToRemove = ['footer', 'nav', 'header'];
    tagsToRemove.forEach(tag => {
        const elements = document.querySelectorAll(tag);
        elements.forEach(element => {
            console.log(`Removing element: ${tag.toUpperCase()}`);
            element.remove();
        });
    });

    // Extract text from remaining content
    const textContent = [...document.body.querySelectorAll('*')]
        .filter(element => element.tagName !== 'STYLE' && element.tagName !== 'SCRIPT')
        .map(element => {
            // Remove any inline styles or scripts embedded within tags
            let text = element.textContent || '';
            text = text.replace(/<style[^>]*>.*?<\/style>/gi, ''); // Remove inline style elements
            text = text.replace(/<script[^>]*>.*?<\/script>/gi, ''); // Remove inline script elements
            return text.trim();
        })
        .filter(text => text.length > 0) // Remove empty text nodes
        .join(' ');

    return textContent;
}



// Extract product information from ecommerce pages with custom rules
// Define custom rules for specific domains
const customScrapingRules = {
    "amazon.com": {
        "productSelector": '.s-main-slot .s-result-item',
        "nameSelector": '.a-size-medium',
        "priceSelector": '.a-price-whole'
    },
    "ebay.com": {
        "productSelector": '.s-item',
        "nameSelector": '.s-item__title',
        "priceSelector": '.s-item__price'
    }
    // Add more domain-specific rules as needed
};

// Function to determine if there are custom rules for a domain
function getCustomRulesForDomain(domain) {
    return customScrapingRules[domain] || null;
}

// Updated extractEcommerceData function using custom rules
function extractEcommerceData(document, domain) {
    const products = [];
    const customRules = getCustomRulesForDomain(domain);
    
    if (customRules) {
        const productElements = document.querySelectorAll(customRules.productSelector);
        productElements.forEach(productElement => {
            const productName = productElement.querySelector(customRules.nameSelector)?.textContent.trim() || '';
            const productPrice = productElement.querySelector(customRules.priceSelector)?.textContent.trim() || '';
            products.push({ name: productName, price: productPrice });
        });
    } else {
        // Fallback to generic selectors if no custom rules are defined
        const possibleProductSelectors = [
            '[class*="product"]', '[class*="item"]', '[id*="product"]', '[id*="item"]'
        ];
        const productElements = document.querySelectorAll(possibleProductSelectors.join(', '));
        
        productElements.forEach(productElement => {
            let productName = '';
            let productPrice = '';

            const nameSelectors = [
                '[class*="name"]', '[class*="title"]', '[itemprop*="name"]',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a'
            ];
            for (const selector of nameSelectors) {
                const nameElement = productElement.querySelector(selector);
                if (nameElement && nameElement.textContent.trim()) {
                    productName = nameElement.textContent.trim();
                    break;
                }
            }

            const priceSelectors = [
                '[class*="price"]', '[itemprop*="price"]', '.price', '.cost',
                '.amount', '[class*="amount"]'
            ];
            for (const selector of priceSelectors) {
                const priceElement = productElement.querySelector(selector);
                if (priceElement && priceElement.textContent.trim()) {
                    productPrice = extractPrice(priceElement.textContent.trim());
                    break;
                }
            }

            if (productName || productPrice) {
                products.push({ name: productName, price: productPrice });
            }
        });
    }

    return products;
}

// Function to extract price using regex
function extractPrice(text) {
    // Regex pattern to match prices (supports various formats and currencies)
    const priceRegex = /(?:[$£€¥₹]|\bUSD|\bEUR|\bGBP|\bJPY|\bINR)?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/;
    const match = text.match(priceRegex);
    return match ? match[0] : '';
}

// Normalize URL
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