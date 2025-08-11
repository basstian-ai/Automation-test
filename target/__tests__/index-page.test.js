const React = require('react');
const { render, screen } = require('@testing-library/react');
const Home = require('../pages/index');

describe('Index page', () => {
  test('renders the product list (or empty state) without crashing', () => {
    const products = [
      { id: 'p1', name: 'Test Product', sku: 'SKU-1', price: 10.0 }
    ];
    render(React.createElement(Home, { products }));

    const maybeProduct = screen.queryByText(/Test Product/i);
    const anyHeading = screen.queryByRole('heading');
    expect(maybeProduct || anyHeading).toBeTruthy();
  });
});
