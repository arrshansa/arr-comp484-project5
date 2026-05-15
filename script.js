/* 
  CSUN Campus Map Quiz — JavaScript
  Uses Google Maps JavaScript API
  jQuery is used for DOM manipulation per project requirements.
*/

/* Map Configuration */

// Center of CSUN campus — adjusted to better frame all 5 buildings
const CSUN_CENTER = { lat: 34.23950515466186, lng: -118.5293287320427 };
const ZOOM_LEVEL = 17; // building-level zoom

/* Location Data
  Each location has:
    name   — display name shown in the log
    hint   — the question shown to the user
    bounds — [[south, west], [north, east]] bounding rectangle
              used to draw the highlight and check if the click was correct
  NOTE: coordinates verified against Google Maps satellite view of CSUN campus
*/
const LOCATIONS = [
  {
    name: "Experimental Theater E1",
    hint: "Where is the Experimental Theater?",
    // Experimental Theater - in the Soraya Center area
    bounds: [
      [34.23640988586853, -118.52796024459178],
      [34.236755153213046, -118.52748104761027],
    ],
  },
  {
    name: "Bayramian Hall",
    hint: "Where is Bayramian Hall?",
    // Bayramian Hall - central campus, south of Plummer St
    bounds: [
      [34.240238297048116, -118.53132399863114],
      [34.240634261200505, -118.53015038647074],
    ],
  },
  {
    name: "Jacaranda Hall",
    hint: "Where is Jacaranda Hall?",
    // Jacaranda Hall - coordinates from Google Maps
    bounds: [
      [34.24105558809146, -118.52946204500807], // south-west corner
      [34.24206668087992, -118.52784199076771], // north-east corner
    ],
  },
  {
    name: "Manzanita Hall",
    hint: "Where is Manzanita Hall?",
    // Manzanita Hall — north-central campus
    bounds: [
      [34.2375654338086, -118.53059310520884],
      [34.237839578031576, -118.529638474713],
    ],
  },
  {
    name: "Citrus Hall",
    hint: "Where is Citrus Hall?",
    // Citrus Hall - northeast area of campus (instructor-chosen)
    bounds: [
      [34.238925307754116, -118.52825713439498],
      [34.23912455422807, -118.52765882531936],
    ],
  },
];

/*  Game State  */
let map; // Google Maps instance
let panorama; // Street View panorama instance
let trafficLayer; // Traffic Layer instance
let maxZoomService; // Max Zoom Service instance
let streetViewService; // Street View Service for checking availability
let currentQ = 0; // index of the current question
let score = { correct: 0, wrong: 0 };
let streak = 0; // consecutive correct answers
let timerSec = 0; // elapsed seconds
let timerHandle = null;
let waiting = false; // blocks extra clicks during feedback delay
let shownRects = []; // tracks drawn rectangles so they can be removed on restart
let wrongAnswers = []; // tracks which questions the user got wrong for the post-game tour
let highScore = localStorage.getItem("csun_hs") || null; // persisted best time

/* Init Map */
/*
  Creates the Google Map centered on the library and registers the double-click handler.
  Also initializes the Traffic Layer, Max Zoom Service, and Street View panorama.
  Panning and zooming are enabled so the user can explore the campus.
*/
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: CSUN_CENTER,
    zoom: ZOOM_LEVEL,
    disableDefaultUI: false,
    gestureHandling: "none",
    keyboardShortcuts: true,
    zoomControl: false,
    scrollwheel: false,
    disableDoubleClickZoom: true,
    draggable: false,
    mapTypeControl: false,
    streetViewControl: false,
    styles: [
      {
        featureType: "all",
        elementType: "labels",
        stylers: [{ visibility: "off" }],
      },
    ],
  });

  // Traffic Layer — shows live traffic conditions on the map
  // Roads are colored green (clear), yellow (slow), or red (heavy traffic)
  trafficLayer = new google.maps.TrafficLayer();
  trafficLayer.setMap(map);

  // Max Zoom Service — used to query the maximum zoom level available
  // for a location, then smoothly zoom into wrong answer buildings
  maxZoomService = new google.maps.MaxZoomService();

  // Street View Service — checks if Street View imagery is available
  // at a given location before attempting to show it
  streetViewService = new google.maps.StreetViewService();

  // Street View Panorama — linked to the map div, hidden by default
  // Activated during the wrong answer tour to show each missed building
  panorama = map.getStreetView();

  map.addListener("dblclick", function (e) {
    handleMapClick(e);
  });
}

/* Wrong Answer Tour */
/*
  After all 5 questions are answered, tours through every building the
  user got wrong. For each one:
    1. Smoothly pans to the building center
    2. Queries max zoom and gradually zooms in
    3. Drops into Street View for 10 seconds so the user can see the building
    4. Exits Street View and gradually zooms back out to campus view
    5. Moves to the next wrong building, or shows the game-over overlay
*/
function runWrongAnswerTour(wrongList, index, onDone) {
  // Base case: tour complete, reset map and fire the done callback
  if (index >= wrongList.length) {
    map.panTo(CSUN_CENTER);
    map.setZoom(ZOOM_LEVEL);
    setTimeout(onDone, 800);
    return;
  }
  // For each wrong building the function first calculates the center point of the building
  // by averaging the bottom left and top right bounds:
  var loc = wrongList[index];
  var center = new google.maps.LatLng(
    (loc.bounds[0][0] + loc.bounds[1][0]) / 2,
    (loc.bounds[0][1] + loc.bounds[1][1]) / 2
  );

  // Step 1 — pan smoothly to the building center
  map.panTo(center);

  // Step 2 — after pan settles, query max zoom and zoom in gradually
  setTimeout(function () {
    maxZoomService.getMaxZoomAtLatLng(center, function (result) {
      if (result.status !== "OK") {
        // If max zoom fails, skips straight to Street View
        showStreetViewThenContinue(center, loc, wrongList, index, onDone);
        return;
      }

      var targetZoom = result.zoom;
      var currentZoom = map.getZoom();
      var zoomStep = 0.4; // zoom increment per frame for smooth animation

      // Gradually zoom in one step at a time
      var zoomInInterval = setInterval(function () {
        currentZoom += zoomStep;
        if (currentZoom >= targetZoom) {
          currentZoom = targetZoom;
          map.setZoom(currentZoom);
          clearInterval(zoomInInterval);

          // Step 3: drop into Street View at max zoom
          showStreetViewThenContinue(center, loc, wrongList, index, onDone);
        } else {
          map.setZoom(currentZoom);
        }
      }, 30); // ~33fps
    });
  }, 600); // wait for pan to settle
}

/* Helper: showStreetViewThenContinue */
/*
  Checks if Street View imagery is available near the building center.
  If available, activates the Street View panorama for 10 seconds,
  then exits and zooms back out before continuing the tour.
  If Street View is unavailable, skips straight to zooming back out.
*/
function showStreetViewThenContinue(center, loc, wrongList, index, onDone) {
  // Search for Street View imagery within 50 metres of the building center
  streetViewService.getPanorama(
    { location: center, radius: 50 },
    function (data, status) {
      if (status === google.maps.StreetViewStatus.OK) {
        // Street View imagery found — activate the panorama
        panorama.setPosition(data.location.latLng);
        panorama.setPov({ heading: 0, pitch: 0 });
        panorama.setVisible(true);

        // Hold Street View for 10 seconds then exit and zoom out
        setTimeout(function () {
          panorama.setVisible(false);
          zoomBackOut(wrongList, index, onDone);
        }, 10000);
      } else {
        // No Street View available at this location — skip to zoom out
        zoomBackOut(wrongList, index, onDone);
      }
    }
  );
}

/* Helper: zoomBackOut */
/*
  Gradually zooms the map back out to the default campus zoom level,
  then continues to the next building in the wrong answer tour.
*/
function zoomBackOut(wrongList, index, onDone) {
  var currentZoom = map.getZoom();
  var zoomStep = 0.4;

  var zoomOutInterval = setInterval(function () {
    currentZoom -= zoomStep;
    if (currentZoom <= ZOOM_LEVEL) {
      currentZoom = ZOOM_LEVEL;
      map.setZoom(currentZoom);
      clearInterval(zoomOutInterval);

      // Move to the next wrong building after a short pause
      setTimeout(function () {
        runWrongAnswerTour(wrongList, index + 1, onDone);
      }, 400);
    } else {
      map.setZoom(currentZoom);
    }
  }, 30); // ~33fps
}

/* Timer */
// Starts the game timer, updating the header display every second.
function startTimer() {
  timerHandle = setInterval(function () {
    timerSec++;
    var m = Math.floor(timerSec / 60);
    var s = String(timerSec % 60).padStart(2, "0");
    $("#timer-val").text(m + ":" + s);
  }, 1000);
}

// Stops the game timer.
function stopTimer() {
  clearInterval(timerHandle);
}

/* Progress Dots */
/*
  Rebuilds the 5 progress dots in the side panel.
  Dots are colored green (correct), red (wrong), red-accent (active), or grey (upcoming).
*/
function renderDots() {
  var $dots = $("#progress-dots").empty();

  LOCATIONS.forEach(function (loc, i) {
    var cls = "";
    if (i < currentQ) {
      // Already answered — color based on result
      cls = shownRects[i] && shownRects[i].correct ? "correct" : "wrong";
    } else if (i === currentQ) {
      cls = "active";
    }
    $dots.append('<div class="dot ' + cls + '"></div>');
  });
}

/* Load Question */
/*
  Displays the current question in the side panel.
  If all questions are done, triggers endGame().
*/
function loadQuestion() {
  if (currentQ >= LOCATIONS.length) {
    endGame();
    return;
  }

  waiting = false; // allow clicks again

  var loc = LOCATIONS[currentQ];
  $("#q-number").text("Question " + (currentQ + 1) + " of " + LOCATIONS.length);
  $("#current-q").text(loc.hint);
  $("#feedback-section").hide();
  $("#feedback").removeClass("correct wrong").text("");
  renderDots();
}

/* Handle Map Click */
/*
  Called on every double-click on the map.
  Checks whether the click falls within the target location's bounding box,
  draws a colored rectangle, shows feedback, and advances to the next question.
  Tracks wrong answers for the post-game zoom and Street View tour.
*/
function handleMapClick(e) {
  // Ignore clicks while showing feedback or after the game ends
  if (waiting || currentQ >= LOCATIONS.length) return;
  waiting = true;

  var loc = LOCATIONS[currentQ];
  var clicked = { lat: e.latLng.lat(), lng: e.latLng.lng() };
  var isCorrect = pointInBounds(clicked, loc.bounds);

  // Draw the correct location rectangle in green (correct) or red (wrong)
  var rect = new google.maps.Rectangle({
    bounds: {
      south: loc.bounds[0][0],
      west: loc.bounds[0][1],
      north: loc.bounds[1][0],
      east: loc.bounds[1][1],
    },
    fillColor: isCorrect ? "#22c55e" : "#ef4444",
    fillOpacity: 0.35,
    strokeColor: isCorrect ? "#22c55e" : "#ef4444",
    strokeWeight: 2,
    map: map,
  });

  // Store the rectangle so we can remove it on restart
  shownRects.push({ rect: rect, correct: isCorrect });

  // Update score and show feedback message
  var $fb = $("#feedback");
  if (isCorrect) {
    score.correct++;
    streak++;
    $fb
      .removeClass("wrong")
      .addClass("correct")
      .text("✓ Your answer is correct!!");
    flashMap("correct");
    if (streak >= 3) showStreakToast();
  } else {
    score.wrong++;
    streak = 0;
    $fb
      .removeClass("correct")
      .addClass("wrong")
      .text("✗ Sorry, wrong location.");
    flashMap("wrong");

    // Track this location for the post-game wrong answer tour
    wrongAnswers.push(loc);
  }

  // Update header stat counters
  $("#correct-val").text(score.correct);
  $("#wrong-val").text(score.wrong);
  $("#streak-val").text(streak);

  // Append an entry to the answer history log
  var resultText = isCorrect ? "✓ Correct!" : "✗ Incorrect";
  var $item = $(
    '<div class="log-item ' +
      (isCorrect ? "correct" : "wrong") +
      '">' +
      '<div class="loc-name">' +
      loc.name +
      "</div>" +
      '<div class="loc-result">' +
      resultText +
      "</div>" +
      "</div>"
  );
  $("#answer-log").append($item);

  $("#feedback-section").show();
  renderDots();

  // Wait 1.8 seconds before moving to the next question
  setTimeout(function () {
    currentQ++;
    loadQuestion();
  }, 1800);
}

/* Helper: pointInBounds */
/*
  Returns true if latlng falls within the given bounding box.
  A small tolerance (~30 m) is added so the quiz is fair.
*/
function pointInBounds(latlng, b) {
  var tol = 0.0004;
  return (
    latlng.lat >= b[0][0] - tol &&
    latlng.lat <= b[1][0] + tol &&
    latlng.lng >= b[0][1] - tol &&
    latlng.lng <= b[1][1] + tol
  );
}

/* Helper: flashMap */
// Briefly flashes the map green or red using a CSS animation class.
function flashMap(type) {
  var $m = $("#map");
  $m.addClass("flash-" + type);
  setTimeout(function () {
    $m.removeClass("flash-correct flash-wrong");
  }, 900);
}

/* Helper: showStreakToast */
// Shows a temporary toast badge when the player is on a streak of 3+.
function showStreakToast() {
  var msgs = ["🔥 ON FIRE!", "🔥 HOT STREAK!", "🔥 UNSTOPPABLE!"];
  var msg = msgs[Math.min(streak - 3, msgs.length - 1)];
  $("#streak-toast").text(msg).addClass("show");
  setTimeout(function () {
    $("#streak-toast").removeClass("show");
  }, 1600);
}

/* End Game */
/*
  Called after the 5th question is answered.
  Stops the timer, then runs the wrong answer zoom and Street View tour
  before showing the game-over overlay so the user can review what they missed.
*/
function endGame() {
  stopTimer();

  // Format elapsed time
  var m = Math.floor(timerSec / 60);
  var s = String(timerSec % 60).padStart(2, "0");
  var timeStr = m + ":" + s;

  // Assign a letter grade based on percentage correct
  var pct = score.correct / LOCATIONS.length;
  var grade = "F";
  if (pct === 1) grade = "A+";
  else if (pct >= 0.8) grade = "A";
  else if (pct >= 0.6) grade = "B";
  else if (pct >= 0.4) grade = "C";
  else if (pct >= 0.2) grade = "D";

  var gradeLetter = grade[0]; // used for the CSS class

  // Check and update high score (stored in localStorage)
  var hsUpdated = false;
  if (!highScore || timerSec < parseInt(highScore)) {
    highScore = timerSec;
    localStorage.setItem("csun_hs", timerSec);
    hsUpdated = true;
  }

  // Populate the overlay fields before showing it
  $("#final-correct").text(score.correct);
  $("#final-total").text(LOCATIONS.length);
  $("#time-taken").text("Time: " + timeStr);
  $("#grade-badge")
    .text(grade)
    .attr("class", "grade " + gradeLetter);

  if (hsUpdated) {
    var hm = Math.floor(highScore / 60);
    var hs = String(highScore % 60).padStart(2, "0");
    $("#hs-display").text(hm + ":" + hs);
    $("#hs-row").show();
  } else {
    $("#hs-row").hide();
  }

  // If there are wrong answers, run the zoom and Street View tour first
  // then show the overlay once the tour is complete
  if (wrongAnswers.length > 0) {
    runWrongAnswerTour(wrongAnswers, 0, function () {
      $("#game-over-overlay").addClass("show");
      $("#map-hint").css("opacity", 0);
    });
  } else {
    // Perfect score — show overlay immediately
    $("#game-over-overlay").addClass("show");
    $("#map-hint").css("opacity", 0);
  }
}

/* Restart */
/*
  Resets all state and starts a new game.
  Called by the "Play Again" button on the game-over overlay.
*/
function restartGame() {
  // Remove all rectangles from the map
  shownRects.forEach(function (r) {
    r.rect.setMap(null);
  });
  shownRects = [];

  // Reset game state
  currentQ = 0;
  score = { correct: 0, wrong: 0 };
  streak = 0;
  timerSec = 0;
  waiting = false;
  wrongAnswers = [];

  // Hide Street View if it was left open
  panorama.setVisible(false);

  // Reset map view to default campus zoom and center
  map.panTo(CSUN_CENTER);
  map.setZoom(ZOOM_LEVEL);

  // Reset UI
  $("#correct-val, #wrong-val, #streak-val").text(0);
  $("#timer-val").text("0:00");
  $("#answer-log").empty();
  $("#feedback-section").hide();
  $("#game-over-overlay").removeClass("show");
  $("#map-hint").css("opacity", 1);

  loadQuestion();
  startTimer();
}

/*
  Hides the game-over overlay so the user can inspect the map.
  Called by the "See Map" button.
*/
function showResults() {
  $("#game-over-overlay").removeClass("show");
}

/* Entry Point */
// Wait for the DOM to be ready, then initialize the map and start the game.
$(function () {
  initMap();
  loadQuestion();
  startTimer();
});
