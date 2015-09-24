var eventChannel;
var model = 'events';
var connectOptions = {
    apiKey: 'testApiKey',
    appId: 'APPID',
    apiEndpoint: 'http://localhost:3000',
    socketEndpoint: 'http://localhost',
    timerInterval: 150
  };


var Telepat = new Telepat();
Telepat.setLogLevel('debug');

Telepat.on('login', function () {
  $('#message').html("");
  subscribe();
});

Telepat.on('logout', function () {
  console.log("logged out");
  $('.list-group').empty();
});

Telepat.on('connect', function () {
  checkLoginState();
});

Telepat.on('contexts-update', function () {
  //
});

function connect() {
  Telepat.connect(connectOptions);
}

function statusChangeCallback(response) {
  if (response.status === 'connected') {
    Telepat.user.loginWithFacebook(response.authResponse.accessToken);
  } else if (response.status === 'not_authorized') {
    $('#message').html('Please log into this app.');
    Telepat.logout();
  } else {
    $('#message').html('Please log into Facebook.');
    Telepat.logout();
  }
}

function checkLoginState() {
  FB.getLoginStatus(function(response) {
    statusChangeCallback(response);
  });
}

function addObject() {
  eventChannel.objects['new'] = {
    text: 'Hello world'
  };
}

function removeObject(id) {
  delete eventChannel.objects[id];
}

function editObject(id) {
  eventChannel.objects[id].text = $('#' + id + '_input').val();
}

function appendToList(key, value) {
  $('.list-group').append('<li class="list-group-item" id="' + key + '">' + key + ': <input type="text" id="' + key + '_input" value="' + value.text + '" onkeyup="editObject(\'' + key + '\');"> <span id="' + key + '_span">' + value.text + '</span><div style="float:right"><a class="btn btn-default btn-sm" href="#" onclick="removeObject(\'' + key + '\'); return false;">Delete</a></div></li>');
}

function subscribe() {
  eventChannel = Telepat.subscribe({ channel: { context: Telepat.contexts[0].id, model: model }}, function () {
    $('#message').empty();
    $.each(eventChannel.objects, function (key, value) {
      appendToList(key, value);
    });
  });
  eventChannel.on('update', function (operation, parentId, parentObject, delta) {
    console.log(operation, parentId, parentObject, delta);
    if (operation == 'delete') {
      $('#' + parentId).remove();
    } else if (operation == 'add') {
      appendToList(parentId, parentObject);
    } else if (operation == 'replace') {
      $('#' + parentId + '_span').text(parentObject[delta.path]);
    }
  });
  eventChannel.on('unsubscribe', function () {
    $('.list-group').empty();
  });
}
