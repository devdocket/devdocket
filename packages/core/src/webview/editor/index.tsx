import { render } from 'preact';
import { EditorApp } from './EditorApp';

const root = document.getElementById('root');
if (root) {
  render(<EditorApp />, root);
}
