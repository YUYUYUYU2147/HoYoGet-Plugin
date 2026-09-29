import fs from 'fs';
import YAML from 'yaml';

class yaml {
  get(path) {
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    return YAML.parse(read);
  }

  /**
   * 整份写回。
   * 只用于配置同步这种「已经拿到完整对象、只增不删」的场景 ——
   * 逐键 yaml.set() 会在补很多键时反复读写同一个文件，而且键名带 '.' 会被
   * setIn 当成嵌套路径。调用方必须保证 obj 是「在原对象上补完」的结果，
   * 不能拿它做「用默认值覆盖用户配置」这种事。
   */
  setAll(path, obj) {
    try {
      fs.writeFileSync(path, YAML.stringify(obj), 'utf-8');
      return true;
    } catch (err) {
      logger.error(err);
      return false;
    }
  }

  set(path, keyname, value) {
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    let D = YAML.parseDocument(read);
    try {
      D.setIn(keyname.split('.'), value);
      fs.writeFileSync(path, YAML.stringify(D), 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
  }

  add(path, keyname, value) {
    let du;
    try {
      du = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    let dd = YAML.parse(du);
    //避免手改yaml时，忘加[]
    if (!Array.isArray(dd[keyname])) {
      let arr = [];
      arr.push(dd[keyname]);
      dd[keyname] = arr;
      du = YAML.stringify(dd);
    }
    let D = YAML.parseDocument(du);
    try {
      D.addIn(keyname.split('.'), value);
      fs.writeFileSync(path, YAML.stringify(D), 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
  }

  del(path, keyname, value) {
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    let D = YAML.parse(read);
    try {
      //非[]，清掉后成空[]
      if (!Array.isArray(D[keyname])) {
        let arr = [];
        arr.push(D[keyname]);
        D[keyname] = arr;
      }
      if (D[keyname].indexOf(value) !== -1) {
        D[keyname].splice(D[keyname].indexOf(value), 1);
        logger.info('del is ok');
        this.set(path, keyname, D[keyname]);
      }
    } catch (err) {
      logger.error(err);
      return false;
    }
  }
}

export default new yaml();
