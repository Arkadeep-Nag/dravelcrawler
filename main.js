const { addUrlToQueue } = require('./crawl');

async function main() {
    // Validate the number of command-line arguments
    if (process.argv.length !== 3) {
        console.log("Usage: node main.js <website URL>");
        process.exit(1);
    }

    const baseURL = process.argv[2];

    // Validate the provided URL
    try {
        new URL(baseURL);
    } catch (err) {
        console.error("Invalid URL provided. Please enter a valid URL.");
        process.exit(1);
    }


    console.log(`Starting crawl of ${baseURL}`);

    // Add the base URL to the queue to start crawling
    await addUrlToQueue(baseURL, 'high');

    console.log(`Crawl initiated for ${baseURL}`);
}

// Call the main function and handle any unexpected errors
main().catch(err => {
    console.error("An unexpected error occurred:", err.message);
    process.exit(1);
});
