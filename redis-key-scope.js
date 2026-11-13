const allowedKey = key => typeof key === 'string' && key.length <= 160 && /^(?:product:|customer:|order:|lab:)[A-Za-z0-9:_-]+$/.test(key);
module.exports={allowedKey};
