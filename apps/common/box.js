import { box as BoxBase } from './lib/box_plugin.js';
import { pluginPriority } from '#HoYoGet';

export class HoYoGetBox extends BoxBase {
  constructor() {
    super();
    this.priority = pluginPriority('box', 5000);
  }
}
