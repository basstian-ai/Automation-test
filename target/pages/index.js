const React = require('react');

function Home({ products = [] }) {
  return React.createElement(
    'div',
    null,
    React.createElement('h1', null, 'Products'),
    products.length > 0
      ? React.createElement(
          'ul',
          null,
          products.map(p =>
            React.createElement('li', { key: p.id }, p.name)
          )
        )
      : React.createElement('p', null, 'No products')
  );
}

module.exports = Home;
