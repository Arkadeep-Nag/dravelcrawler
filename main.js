const { addUrlToQueue } = require('./crawl');

async function main() {
    // Validate the number of command-line arguments
    if (process.argv.length !== 3) {
        console.log("Usage: node main.js <website URL>");
        process.exit(1);
    }

    const baseURL = process.argv[2];

    // Validate the provided URL
    let validUrl;
    try {
        validUrl = new URL(baseURL);
    } catch (err) {
        console.error("Invalid URL provided. Please enter a valid URL.");
        process.exit(1);
    }

    // Further validate that the URL is reachable (optional)
    try {
        const response = await fetch(validUrl.href);
        if (!response.ok) {
            throw new Error(`URL returned status code ${response.status}`);
        }
    } catch (err) {
        console.error(`Error validating URL: ${err.message}`);
        process.exit(1);
    }

    console.log(`Starting crawl of ${validUrl.href}`);

    // Add the base URL to the queue to start crawling
    try {
        await addUrlToQueue(validUrl.href, 'high');
        console.log(`Crawl initiated for ${validUrl.href}`);
    } catch (err) {
        console.error(`Failed to add URL to queue: ${err.message}`);
        process.exit(1);
    }
}

// Call the main function and handle any unexpected errors
main().catch(err => {
    console.error("An unexpected error occurred:", err.message);
    process.exit(1);
});
