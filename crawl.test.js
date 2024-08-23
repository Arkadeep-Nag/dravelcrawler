const {normalizeURL,getURLsfromHTML} = require('./crawl.js')
const {test, expect} = require('@jest/globals')


test('normalizeURL strip protocol', () => {
	const input = 'https://blog.boot.dev/path'
	const actual = normalizeURL(input)
	const expected = 'blog.boot.dev/path'
	expect(actual).toEqual(expected)
})

test('normalizeURL strip trailing slash', () => {
	const input = 'https://blog.boot.dev/path/'
	const actual = normalizeURL(input)
	const expected = 'blog.boot.dev/path'
	expect(actual).toEqual(expected)
})

test('normalizeURL capitals', () => {
	const input = 'https://BLOG.boot.dev/path/'
	const actual = normalizeURL(input)
	const expected = 'blog.boot.dev/path'
	expect(actual).toEqual(expected)
})

test('normalizeURL strip http', () => {
	const input = 'http://blog.boot.dev/path/'
	const actual = normalizeURL(input)
	const expected = 'blog.boot.dev/path'
	expect(actual).toEqual(expected)
})

test('getURLsfromHTML absolute', () => {
	const inputHTML = `
	<html>
		<body>
			<a href="https://blog.boot.dev">
			Boot dev blog
			</a>
		</body>
	</html>
	`
	const inputBaseURL = "https://blog.boot.dev" 
	const actual = getURLsfromHTML(inputHTML, inputBaseURL)
	const expected = ["https://blog.boot.dev/"]
	expect(actual).toEqual(expected)
})

test('getURLsfromHTML relative', () => {
	const inputHTML = `
	<html>
		<body>
			<a href="/path/">
			Boot dev blog
			</a>
		</body>
	</html>
	`
	const inputBaseURL = "https://blog.boot.dev" 
	const actual = getURLsfromHTML(inputHTML, inputBaseURL)
	const expected = ["https://blog.boot.dev/path/"]
	expect(actual).toEqual(expected)
})


test('getURLsfromHTML both', () => {
	const inputHTML = `
	<html>
		<body>
		<a href="https://blog.boot.dev/path1/">
			Boot dev blog
			</a>
			<a href="/path2/">
			Boot dev blog
			</a>
		</body>
	</html>
	`
	const inputBaseURL = "https://blog.boot.dev" 
	const actual = getURLsfromHTML(inputHTML, inputBaseURL)
	const expected = ["https://blog.boot.dev/path1/","https://blog.boot.dev/path2/"]
	expect(actual).toEqual(expected)
})

test('getURLsfromHTML invalid', () => {
	const inputHTML = `
	<html>
		<body>
			<a href="invalid">
			Boot dev blog
			</a>
		</body>
	</html>
	`
	const inputBaseURL = "https://blog.boot.dev" 
	const actual = getURLsfromHTML(inputHTML, inputBaseURL)
	const expected = []
	expect(actual).toEqual(expected)
})