import { render } from 'preact';
import { WatchApp } from './WatchApp';

const root = document.getElementById('root');
if (root) {
  render(<WatchApp />, root);
}
